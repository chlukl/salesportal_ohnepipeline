import type { HeaderCounters, PendenzenResponse } from '@sales-portal/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/helpers';
import { auditLog, mockCrmTasks } from '../../db/schema';
import { demoUser } from '../../db/seed/users';
import { IDS, seedFixtures } from './fixtures.testutil';

let t: TestApp;
const MARKUS = demoUser('markus');
const MANUEL = demoUser('manuel');

beforeAll(async () => {
  t = await createTestApp();
  await seedFixtures(t.ctx.db);
});
afterAll(async () => {
  await t?.close();
});

async function get(user: 'lukas' | 'markus' | 'manuel' | 'nico', url: string) {
  const s = await t.login(user);
  return t.app.inject({ method: 'GET', url, headers: { cookie: s.cookie } });
}
async function send(user: 'lukas' | 'markus' | 'manuel' | 'nico', method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const s = await t.login(user);
  return t.app.inject({ method, url, headers: { ...s.headers, ...(payload ? { 'content-type': 'application/json' } : {}) }, payload: payload as never });
}
const ids = (r: PendenzenResponse) => r.items.map((i) => i.id);

describe('GET /api/pendenzen – per person and role (6.16)', () => {
  it('coldcaller: unfinished call, due callback and tasks on top; analyses, approvals, errors, cancellations', async () => {
    const res = await get('markus', '/api/pendenzen');
    expect(res.statusCode).toBe(200);
    const body = res.json() as PendenzenResponse;
    expect(body.person.id).toBe(MARKUS.id);
    expect(body.coldcallerFirst).toBe(true);
    expect(body.items[0]).toMatchObject({ id: `call:${IDS.sessionUnfinished}`, kind: 'unfinished_call', statusLabel: 'Ergebnis fehlt' });
    expect(body.items[1]).toMatchObject({ id: `task:${IDS.taskMarkusCallback}`, due: 'overdue', taskType: 'callback' });
    expect(ids(body)).toEqual(
      expect.arrayContaining([
        `analysis:${IDS.analysisReady}`,
        `approval:${IDS.csPending}`,
        `error:${IDS.csFailed}`,
        `cancellation:${IDS.bookingCancelled}`,
        `task:${IDS.taskMarkusLater}`,
      ]),
    );
    // Missed callbacks belong to the history; meetings to sales/AI.
    expect(ids(body)).not.toContain(`call:${IDS.sessionMissed}`);
    expect(body.items.some((i) => i.kind === 'booking' || i.kind === 'briefing')).toBe(false);
    // Lead enrichment + origin: campaign lead → «Kampagne».
    expect(body.items.find((i) => i.id === `task:${IDS.taskMarkusLater}`)?.origin).toBe('campaign');
    expect(body.items.find((i) => i.id === `approval:${IDS.csPending}`)?.subtitle).toContain('Gamma Logistik AG');
  });

  it('sales: own meetings with briefing (preparation) and own follow-up tasks, no coldcall items', async () => {
    const body = (await get('manuel', '/api/pendenzen')).json() as PendenzenResponse;
    expect(body.coldcallerFirst).toBe(false);
    expect(ids(body)).toEqual(
      expect.arrayContaining([`booking:${IDS.bookingManuel}`, `briefing:${IDS.bookingManuel}`, `task:${IDS.taskManuel}`, `cancellation:${IDS.bookingCancelled}`]),
    );
    expect(body.items.some((i) => ['unfinished_call', 'analysis', 'approval'].includes(i.kind))).toBe(false);
    const briefing = body.items.find((i) => i.id === `briefing:${IDS.bookingManuel}`)!;
    expect(briefing).toMatchObject({ statusLabel: 'offen', tone: 'warning', origin: 'campaign' });
    expect(briefing.subtitle).toContain('Vorbereitung nötig');
    expect(briefing.actions).toEqual(expect.arrayContaining(['open_briefing', 'mark_done']));
  });

  it('cancellation «neu planen» opens the Termin tab only for those who can book; for Sales it is information', async () => {
    const key = `cancellation:${IDS.bookingCancelled}`;
    const coldcaller = ((await get('markus', '/api/pendenzen')).json() as PendenzenResponse).items.find((i) => i.id === key)!;
    expect(coldcaller.link).toBe(`/lead/${IDS.leadAlpha}?panel=scheduling`);
    expect(coldcaller.subtitle).toContain('neu planen');
    const sales = ((await get('manuel', '/api/pendenzen')).json() as PendenzenResponse).items.find((i) => i.id === key)!;
    expect(sales.link).toBe(`/lead/${IDS.leadAlpha}`);
    expect(sales.subtitle).not.toContain('neu planen');
    expect(sales.actions).toEqual(expect.arrayContaining(['mark_done']));
  });

  it('AI specialist sees all first meetings and briefings', async () => {
    const body = (await get('nico', '/api/pendenzen')).json() as PendenzenResponse;
    expect(ids(body)).toEqual(expect.arrayContaining([`booking:${IDS.bookingManuel}`, `briefing:${IDS.bookingManuel}`]));
    expect(body.items.some((i) => i.kind === 'task' || i.kind === 'unfinished_call')).toBe(false);
  });

  it('admin «Ansicht als» Sales only gets sales items', async () => {
    const s = await t.login('lukas', { fresh: true });
    const put = await t.app.inject({ method: 'PUT', url: '/api/me/view-as', headers: { ...s.headers, 'content-type': 'application/json' }, payload: { role: 'sales' } });
    expect(put.statusCode).toBe(200);
    const body = (await t.app.inject({ method: 'GET', url: '/api/pendenzen', headers: { cookie: s.cookie } })).json() as PendenzenResponse;
    expect(body.person.roles).toEqual(['sales']);
    expect(body.items.some((i) => i.kind === 'unfinished_call' || i.kind === 'error')).toBe(false);
    // Real admin may still look at another person while viewing as a role.
    const other = await t.app.inject({ method: 'GET', url: `/api/pendenzen?userId=${MARKUS.id}`, headers: { cookie: s.cookie } });
    expect(other.statusCode).toBe(200);
  });
});

describe('object-level authorization: everyone may look, only own (admin: all) can be edited', () => {
  it('non-admins may look at another person – read-only, without mutating actions', async () => {
    for (const [who, other] of [['markus', MANUEL], ['manuel', MARKUS], ['nico', MARKUS]] as const) {
      const res = await get(who, `/api/pendenzen?userId=${other.id}`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as PendenzenResponse;
      expect(body.person.id).toBe(other.id);
      expect(body.readOnly).toBe(true);
      for (const item of body.items) {
        expect(item.actions.filter((a) => ['complete', 'reschedule', 'mark_done', 'snooze'].includes(a))).toEqual([]);
      }
    }
    const markusView = (await get('manuel', `/api/pendenzen?userId=${MARKUS.id}`)).json() as PendenzenResponse;
    expect(ids(markusView)).toContain(`call:${IDS.sessionUnfinished}`);
    const persons = (await get('markus', '/api/pendenzen/persons')).json().items as { id: string }[];
    expect(persons.map((p) => p.id)).toContain(MANUEL.id);
  });

  it('own list is editable for everybody', async () => {
    const res = await get('markus', `/api/pendenzen?userId=${MARKUS.id}`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as PendenzenResponse).readOnly).toBe(false);
    expect(((await get('markus', '/api/pendenzen')).json() as PendenzenResponse).readOnly).toBe(false);
  });

  it('team view: all persons in one list, shared items once with all owner names, always read-only', async () => {
    for (const who of ['markus', 'lukas'] as const) {
      const res = await get(who, '/api/pendenzen?userId=team');
      expect(res.statusCode).toBe(200);
      const body = res.json() as PendenzenResponse;
      expect(body.person.id).toBe('team');
      expect(body.readOnly).toBe(true);
      expect(ids(body)).toContain(`call:${IDS.sessionUnfinished}`);
      expect(new Set(ids(body)).size).toBe(ids(body).length);
      expect(body.items.every((i) => !!i.ownerName && (i.ownerNames?.length ?? 0) >= 1)).toBe(true);
      expect(body.items.some((i) => i.actions.includes('complete') || i.actions.includes('mark_done'))).toBe(false);
    }
  });

  it('admin sees the Pendenzen of Markus via the person filter', async () => {
    const res = await get('lukas', `/api/pendenzen?userId=${MARKUS.id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as PendenzenResponse;
    expect(body.person).toMatchObject({ id: MARKUS.id, displayName: 'Markus', roles: ['coldcaller'] });
    expect(body.readOnly).toBe(false);
    expect(ids(body)).toContain(`call:${IDS.sessionUnfinished}`);
    const persons = (await get('lukas', '/api/pendenzen/persons')).json().items as { id: string }[];
    expect(persons.map((p) => p.id)).toContain(MARKUS.id);
  });

  it('unknown person → 404 for admin', async () => {
    expect((await get('lukas', '/api/pendenzen?userId=00000000-0000-4000-8000-0000000000ff')).statusCode).toBe(404);
  });

  it('non-admins cannot complete or reschedule tasks of others', async () => {
    expect((await send('markus', 'POST', `/api/pendenzen/tasks/${IDS.taskManuel}/complete`, {})).statusCode).toBe(404);
    expect((await send('markus', 'POST', `/api/pendenzen/tasks/${IDS.taskManuel}/complete`, { userId: MANUEL.id })).statusCode).toBe(403);
    const [task] = await t.ctx.db.select().from(mockCrmTasks).where(eq(mockCrmTasks.activityid, IDS.taskManuel));
    expect(task.statecode).toBe(0);
  });
});

describe('filters', () => {
  it('Art, Fälligkeit, Herkunft, Firma, Status', async () => {
    const tasks = (await get('markus', '/api/pendenzen?kinds=task')).json() as PendenzenResponse;
    expect(tasks.items.every((i) => i.kind === 'task')).toBe(true);
    expect(tasks.counts.unfinished_call).toBe(1);
    const overdue = (await get('markus', '/api/pendenzen?due=overdue')).json() as PendenzenResponse;
    expect(overdue.items.every((i) => i.due === 'overdue')).toBe(true);
    expect(ids(overdue)).toContain(`task:${IDS.taskMarkusCallback}`);
    const campaign = (await get('markus', '/api/pendenzen?origins=campaign')).json() as PendenzenResponse;
    expect(campaign.items.length).toBeGreaterThan(0);
    expect(campaign.items.every((i) => i.origin === 'campaign')).toBe(true);
    const company = (await get('markus', '/api/pendenzen?company=alpha')).json() as PendenzenResponse;
    expect(company.items.length).toBeGreaterThan(0);
    expect(company.items.every((i) => `${i.companyName} ${i.title} ${i.subtitle}`.toLowerCase().includes('alpha'))).toBe(true);
  });

  it('rejects invalid filter values', async () => {
    expect((await get('markus', '/api/pendenzen?kinds=bogus')).statusCode).toBe(400);
    expect((await get('markus', '/api/pendenzen?userId=not-a-uuid')).statusCode).toBe(400);
  });
});

describe('inline actions', () => {
  it('erledigen closes the CRM task and writes the audit log', async () => {
    const res = await send('markus', 'POST', `/api/pendenzen/tasks/${IDS.taskMarkusCallback}/complete`, {});
    expect(res.statusCode).toBe(200);
    const [task] = await t.ctx.db.select().from(mockCrmTasks).where(eq(mockCrmTasks.activityid, IDS.taskMarkusCallback));
    expect(task.statecode).toBe(1);
    const entries = await t.ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'pendenzen.task_complete'), eq(auditLog.entityId, IDS.taskMarkusCallback)));
    expect(entries).toHaveLength(1);
    expect(entries[0].actorUserId).toBe(MARKUS.id);
    const open = (await get('markus', '/api/pendenzen')).json() as PendenzenResponse;
    expect(ids(open)).not.toContain(`task:${IDS.taskMarkusCallback}`);
    const done = (await get('markus', '/api/pendenzen?status=done&kinds=task')).json() as PendenzenResponse;
    expect(ids(done)).toContain(`task:${IDS.taskMarkusCallback}`);
    // A completed task cannot be completed again.
    expect((await send('markus', 'POST', `/api/pendenzen/tasks/${IDS.taskMarkusCallback}/complete`, {})).statusCode).toBe(404);
  });

  it('verschieben moves the CRM task (admin for another person, audited)', async () => {
    const dueAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const res = await send('lukas', 'POST', `/api/pendenzen/tasks/${IDS.taskManuel}/reschedule`, { dueAt, userId: MANUEL.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().dueAt).toBe(dueAt);
    const [task] = await t.ctx.db.select().from(mockCrmTasks).where(eq(mockCrmTasks.activityid, IDS.taskManuel));
    expect(task.scheduledend?.toISOString()).toBe(dueAt);
    const [entry] = await t.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'pendenzen.task_reschedule'), eq(auditLog.entityId, IDS.taskManuel)));
    expect(entry.newValue).toBe(dueAt);
    expect((await send('manuel', 'POST', `/api/pendenzen/tasks/${IDS.taskManuel}/reschedule`, { dueAt: 'morgen' })).statusCode).toBe(400);
  });

  it('briefing «erledigt» (portal state) and undo', async () => {
    const key = `briefing:${IDS.bookingManuel}`;
    expect((await send('manuel', 'PUT', '/api/pendenzen/state', { itemKey: key, done: true })).statusCode).toBe(200);
    expect(ids((await get('manuel', '/api/pendenzen')).json())).not.toContain(key);
    expect(ids((await get('manuel', '/api/pendenzen?status=done')).json())).toContain(key);
    // State is per person: Nico still has the briefing open.
    expect(ids((await get('nico', '/api/pendenzen')).json())).toContain(key);
    await send('manuel', 'PUT', '/api/pendenzen/state', { itemKey: key, done: false });
    expect(ids((await get('manuel', '/api/pendenzen')).json())).toContain(key);
  });

  it('verschieben of a portal Pendenz moves its due date', async () => {
    const key = `cancellation:${IDS.bookingCancelled}`;
    const until = new Date(Date.now() + 20 * 86_400_000).toISOString();
    expect((await send('markus', 'PUT', '/api/pendenzen/state', { itemKey: key, snoozedUntil: until })).statusCode).toBe(200);
    const item = ((await get('markus', '/api/pendenzen')).json() as PendenzenResponse).items.find((i) => i.id === key)!;
    expect(item).toMatchObject({ snoozedUntil: until, due: 'later' });
  });

  it('rejects state for CRM tasks or other persons', async () => {
    expect((await send('markus', 'PUT', '/api/pendenzen/state', { itemKey: `task:${IDS.taskMarkusLater}`, done: true })).statusCode).toBe(400);
    expect((await send('markus', 'PUT', '/api/pendenzen/state', { itemKey: `briefing:${IDS.bookingManuel}`, done: true, userId: MANUEL.id })).statusCode).toBe(403);
  });
});

describe('saved filters (scope pendenzen)', () => {
  it('create, list, update, delete – own filters only', async () => {
    const created = await send('markus', 'POST', '/api/pendenzen/filters', { name: 'Heute fällig', filter: { due: ['overdue', 'today'], kinds: ['task'] }, isDefault: true });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const list = (await get('markus', '/api/pendenzen/filters')).json().items as { id: string; isDefault: boolean }[];
    expect(list).toEqual([expect.objectContaining({ id, isDefault: true })]);
    // Other users do not see or touch it.
    expect((await get('manuel', '/api/pendenzen/filters')).json().items).toEqual([]);
    expect((await send('manuel', 'DELETE', `/api/pendenzen/filters/${id}`)).statusCode).toBe(404);
    expect((await send('manuel', 'PUT', `/api/pendenzen/filters/${id}`, { name: 'x' })).statusCode).toBe(404);
    const updated = await send('markus', 'PUT', `/api/pendenzen/filters/${id}`, { name: 'Rückrufe' });
    expect(updated.json()).toMatchObject({ name: 'Rückrufe', filter: { due: ['overdue', 'today'] } });
    expect((await send('markus', 'DELETE', `/api/pendenzen/filters/${id}`)).statusCode).toBe(204);
  });

  it('validates the filter shape', async () => {
    expect((await send('markus', 'POST', '/api/pendenzen/filters', { name: 'x', filter: { kinds: ['nope'] } })).statusCode).toBe(400);
    expect((await send('markus', 'POST', '/api/pendenzen/filters', { name: 'x', filter: { evil: 1 } })).statusCode).toBe(400);
  });
});

describe('header counter', () => {
  it('counts open, due Pendenzen for the current user', async () => {
    const markus = (await get('markus', '/api/me/counters')).json() as HeaderCounters;
    expect(markus.pendenzen).toBeGreaterThan(0);
    const nico = (await get('nico', '/api/me/counters')).json() as HeaderCounters;
    expect(nico.missedCallbacks).toBe(0);
  });
});
