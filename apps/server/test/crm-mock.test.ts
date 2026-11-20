import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Lead, Paged } from '@sales-portal/shared';
import { createTestApp, type TestApp } from './helpers';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ demoCrm: true });
});
afterAll(async () => {
  await t?.close();
});

describe('demo seed + mock CRM read side', () => {
  it('seeds ~400 leads deterministically and idempotently', async () => {
    const { seedDemo } = await import('../src/db/seed/demo');
    const again = await seedDemo(t.ctx.db);
    expect(again.seeded).toBe(false);
    const all = await t.ctx.adapters.system().crm.listLeads({ includeHidden: true, campaign: 'all', pageSize: 200 });
    expect(all.total).toBe(400);
  });

  it('call list hides closed / Divendo / locked campaign leads for the coldcaller', async () => {
    const s = await t.login('markus');
    const res = await t.app.inject({ method: 'GET', url: '/api/leads?pageSize=200&includeHidden=true', headers: { cookie: s.cookie } });
    expect(res.statusCode).toBe(200);
    const page = res.json() as Paged<Lead>;
    expect(page.total).toBeGreaterThan(150);
    expect(page.total).toBeLessThan(400);
    for (const lead of page.items) expect(lead.exclusions).toEqual([]);
  });

  it('admin can include hidden leads', async () => {
    const s = await t.login('lukas');
    const visible = (await t.app.inject({ method: 'GET', url: '/api/leads?pageSize=1', headers: { cookie: s.cookie } })).json();
    const all = (await t.app.inject({ method: 'GET', url: '/api/leads?pageSize=1&includeHidden=true&campaign=all', headers: { cookie: s.cookie } })).json();
    expect(all.total).toBe(400);
    expect(visible.total).toBeLessThan(all.total);
  });

  it('filters and sorts (grade A/B by score desc)', async () => {
    const s = await t.login('markus');
    const page = (await t.app.inject({ method: 'GET', url: '/api/leads?grades=A,B&pageSize=50', headers: { cookie: s.cookie } })).json() as Paged<Lead>;
    expect(page.items.length).toBeGreaterThan(0);
    for (const l of page.items) expect(['A', 'B']).toContain(l.grade);
    const scores = page.items.map((l) => l.kls_leadscore ?? 0);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('computes phones, campaign badge and real contact', async () => {
    const crm = t.ctx.adapters.system().crm;
    const all = (await crm.listLeads({ includeHidden: true, campaign: 'all', pageSize: 200, page: 1 })).items.concat(
      (await crm.listLeads({ includeHidden: true, campaign: 'all', pageSize: 200, page: 2 })).items,
    );
    expect(all.some((l) => l.phones.some((p) => p.status === 'multiple'))).toBe(true);
    expect(all.some((l) => l.phones.some((p) => p.status === 'ok' && p.extension))).toBe(true);
    expect(all.some((l) => l.campaign.locked)).toBe(true);
    expect(all.some((l) => l.campaign.fromCampaign)).toBe(true);
    expect(all.some((l) => l.lastRealContact !== null)).toBe(true);
    expect(all.some((l) => l.assessment?.einstieg)).toBe(true);
  });

  it('workspace, persons, timeline and callback search', async () => {
    const crm = t.ctx.adapters.system().crm;
    const withCalls = (await crm.listLeads({ statusCodes: [2], pageSize: 50 })).items.find((l) => l.primaryPhone);
    expect(withCalls).toBeDefined();
    const s = await t.login('markus');
    const ws = (await t.app.inject({ method: 'GET', url: `/api/workspace/${withCalls!.leadid}`, headers: { cookie: s.cookie } })).json();
    expect(ws.lead.leadid).toBe(withCalls!.leadid);
    expect(ws.persons.some((p: { isCurrent: boolean }) => p.isCurrent)).toBe(true);
    expect(ws.timeline.length).toBeGreaterThan(0);

    const national = `0${withCalls!.primaryPhone!.e164!.slice(3)}`; // +4161… → 061…
    const matches = await crm.searchByPhone(national);
    expect(matches.some((m) => m.leadId === withCalls!.leadid)).toBe(true);
  });

  it('tasks for Markus include overdue and today', async () => {
    const crm = t.ctx.adapters.system().crm;
    const tasks = await crm.listTasks({ ownerId: 'c0000000-0000-4000-8000-000000000002' });
    const now = Date.now();
    expect(tasks.some((x) => x.dueAt && Date.parse(x.dueAt) < now)).toBe(true);
    expect(tasks.length).toBeGreaterThan(10);
  });
});
