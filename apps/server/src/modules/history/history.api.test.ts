import { RESULT_GROUP_CODES, type CallbackSearchResponse, type HeaderCounters, type HistoryResponse } from '@sales-portal/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/helpers';
import { auditLog, callSessions, phoneAssignments } from '../../db/schema';
import { demoUser } from '../../db/seed/users';
import { IDS, seedFixtures, UNKNOWN_NUMBER } from '../pendenzen/fixtures.testutil';

let t: TestApp;
const MARKUS = demoUser('markus');
const LUKAS = demoUser('lukas');

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
async function send(user: 'lukas' | 'markus' | 'manuel' | 'nico', method: 'POST' | 'DELETE', url: string, payload?: unknown) {
  const s = await t.login(user);
  return t.app.inject({ method, url, headers: { ...s.headers, ...(payload ? { 'content-type': 'application/json' } : {}) }, payload: payload as never });
}

describe('GET /api/history (6.15)', () => {
  it('lists the calls of the user newest first with categories', async () => {
    const res = await get('markus', '/api/history');
    expect(res.statusCode).toBe(200);
    const body = res.json() as HistoryResponse;
    const at = body.items.map((i) => i.at);
    expect([...at].sort().reverse()).toEqual(at);
    const outbound = body.items.find((i) => i.id === 'pc:pc-alpha-1')!;
    expect(outbound).toMatchObject({
      category: 'outbound',
      personName: 'Anna Muster',
      companyName: 'Alpha Treuhand AG',
      phoneDisplay: '+41 61 555 01 02',
      resultCode: RESULT_GROUP_CODES.callback,
      notePreview: 'Sales-Portal: GL bittet um Rückruf nächste Woche.',
    });
    const missed = body.items.find((i) => i.id === `cs:${IDS.sessionMissed}`)!;
    expect(missed).toMatchObject({ category: 'callback_missed', open: true, sessionId: IDS.sessionMissed });
    expect(missed.lastOutbound?.resultCode).toBe(RESULT_GROUP_CODES.callback);
    expect(body.items.find((i) => i.id === `cs:${IDS.sessionUnknown}`)).toMatchObject({ category: 'unknown_number', assignable: true, leadId: null });
    expect(body.openMissed).toBe(1);
    expect(body.counts.callback_missed).toBe(1);
  });

  it('filters by category, result and search', async () => {
    const missed = (await get('markus', '/api/history?categories=callback_missed')).json() as HistoryResponse;
    expect(missed.items.map((i) => i.id)).toEqual([`cs:${IDS.sessionMissed}`]);
    const byResult = (await get('markus', `/api/history?resultCodes=${RESULT_GROUP_CODES.callback}`)).json() as HistoryResponse;
    expect(byResult.items.map((i) => i.id)).toEqual(['pc:pc-alpha-1']);
    const byNumber = (await get('markus', `/api/history?search=${encodeURIComponent('061 555 01 02')}`)).json() as HistoryResponse;
    expect(byNumber.items.length).toBeGreaterThanOrEqual(2);
    expect(byNumber.items.every((i) => i.phoneE164 === '+41615550102')).toBe(true);
    expect((await get('markus', '/api/history?day=20.11.2026')).statusCode).toBe(400);
  });

  it('is for coldcallers and admins only; other persons only for admins', async () => {
    expect((await get('manuel', '/api/history')).statusCode).toBe(403);
    expect((await get('nico', '/api/history/callback-search?q=0615550102')).statusCode).toBe(403);
    expect((await get('markus', `/api/history?userId=${LUKAS.id}`)).statusCode).toBe(403);
    const admin = await get('lukas', `/api/history?userId=${MARKUS.id}`);
    expect(admin.statusCode).toBe(200);
    expect((admin.json() as HistoryResponse).openMissed).toBe(1);
  });
});

describe('missed callbacks: header counter and «erledigt»', () => {
  it('counter shows open missed callbacks; marking done (and undo) updates it', async () => {
    expect(((await get('markus', '/api/me/counters')).json() as HeaderCounters).missedCallbacks).toBe(1);
    const done = await send('markus', 'POST', `/api/history/sessions/${IDS.sessionMissed}/handled`, { handled: true });
    expect(done.statusCode).toBe(200);
    expect(((await get('markus', '/api/me/counters')).json() as HeaderCounters).missedCallbacks).toBe(0);
    const [row] = await t.ctx.db.select().from(callSessions).where(eq(callSessions.id, IDS.sessionMissed));
    expect(row.handledAt).not.toBeNull();
    expect(await t.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'history.callback_handled'), eq(auditLog.entityId, IDS.sessionMissed)))).toHaveLength(1);
    await send('markus', 'POST', `/api/history/sessions/${IDS.sessionMissed}/handled`, { handled: false });
    expect(((await get('markus', '/api/me/counters')).json() as HeaderCounters).missedCallbacks).toBe(1);
  });

  it('only real missed callbacks / unknown numbers can be marked, only own (admin excepted)', async () => {
    expect((await send('markus', 'POST', `/api/history/sessions/${IDS.sessionUnfinished}/handled`, { handled: true })).statusCode).toBe(400);
    expect((await send('manuel', 'POST', `/api/history/sessions/${IDS.sessionMissed}/handled`, { handled: true })).statusCode).toBe(403);
    expect((await send('markus', 'POST', '/api/history/sessions/00000000-0000-4000-8000-0000000000ff/handled', { handled: true })).statusCode).toBe(404);
  });

  it('a later outgoing call closes the missed callback automatically', async () => {
    const [back] = await t.ctx.db
      .insert(callSessions)
      .values({ userId: MARKUS.id, leadId: IDS.leadAlpha, phoneE164: '+41615550102', direction: 'outbound', category: 'outbound', status: 'completed', dialedAt: new Date() })
      .returning();
    const body = (await get('markus', '/api/history')).json() as HistoryResponse;
    expect(body.items.find((i) => i.id === `cs:${IDS.sessionMissed}`)?.open).toBe(false);
    expect(((await get('markus', '/api/me/counters')).json() as HeaderCounters).missedCallbacks).toBe(0);
    await t.ctx.db.delete(callSessions).where(eq(callSessions.id, back.id));
  });
});

describe('Rückruf-Suche (6.18)', () => {
  it('finds the lead by number in any format, with the last call and its reason', async () => {
    for (const q of ['061 555 01 02', '+41615550102', '0041 61 555 01 02', '+41 (0)61 555 01 02']) {
      const res = await get('markus', `/api/history/callback-search?q=${encodeURIComponent(q)}`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as CallbackSearchResponse;
      expect(body.mode).toBe('phone');
      expect(body.e164).toBe('+41615550102');
      const hit = body.hits.find((h) => h.leadId === IDS.leadAlpha)!;
      expect(hit).toMatchObject({ source: 'lead', name: 'Anna Muster', companyName: 'Alpha Treuhand AG' });
      expect(hit.lastCall).toMatchObject({ resultCode: RESULT_GROUP_CODES.callback, subject: 'Erstkontakt Alpha' });
    }
  });

  it('partial numbers (suffix) and names work, too-short input does not search', async () => {
    const partial = (await get('markus', '/api/history/callback-search?q=3334455')).json() as CallbackSearchResponse;
    expect(partial.hits.map((h) => h.leadId)).toContain(IDS.leadBeta);
    expect(partial.unknown).toBe(false);
    const byName = (await get('markus', '/api/history/callback-search?q=Holzbau')).json() as CallbackSearchResponse;
    expect(byName.mode).toBe('name');
    expect(byName.hits.map((h) => h.leadId)).toContain(IDS.leadBeta);
    expect(((await get('markus', '/api/history/callback-search?q=0612')).json() as CallbackSearchResponse).mode).toBe('too_short');
    expect((await get('markus', '/api/history/callback-search?q=')).statusCode).toBe(400);
  });

  it('unknown number → «nicht im CRM» → assign to a lead → found next time, history shows the person', async () => {
    const unknown = (await get('markus', `/api/history/callback-search?q=${encodeURIComponent('044 555 01 23')}`)).json() as CallbackSearchResponse;
    expect(unknown).toMatchObject({ mode: 'phone', unknown: true, hits: [] });

    expect((await send('markus', 'POST', '/api/history/assignments', { phone: 'abc', leadId: IDS.leadBeta })).statusCode).toBe(400);
    expect((await send('markus', 'POST', '/api/history/assignments', { phone: '044 555 01 23', leadId: 'does-not-exist' })).statusCode).toBe(404);
    const assigned = await send('markus', 'POST', '/api/history/assignments', { phone: '044 555 01 23', leadId: IDS.leadBeta });
    expect(assigned.statusCode).toBe(201);
    expect(assigned.json()).toMatchObject({ phoneE164: UNKNOWN_NUMBER, leadId: IDS.leadBeta, companyName: 'Beta Holzbau GmbH' });

    const found = (await get('markus', `/api/history/callback-search?q=${encodeURIComponent('+41 44 555 01 23')}`)).json() as CallbackSearchResponse;
    expect(found.unknown).toBe(false);
    expect(found.hits[0]).toMatchObject({ source: 'assignment', leadId: IDS.leadBeta, companyName: 'Beta Holzbau GmbH' });

    const history = (await get('markus', '/api/history')).json() as HistoryResponse;
    expect(history.items.find((i) => i.id === `cs:${IDS.sessionUnknown}`)).toMatchObject({
      category: 'callback_missed',
      leadId: IDS.leadBeta,
      companyName: 'Beta Holzbau GmbH',
      assignable: false,
    });

    // Undo: only the assigning user (or admin) may remove it.
    const id = assigned.json().id as string;
    expect((await send('manuel', 'DELETE', `/api/history/assignments/${id}`)).statusCode).toBe(403);
    expect((await send('lukas', 'DELETE', `/api/history/assignments/${id}`)).statusCode).toBe(204);
    expect(await t.ctx.db.select().from(phoneAssignments)).toHaveLength(0);
  });
});
