/** Smoke test against the ~400-lead demo dataset: every role gets its Pendenzen, Markus his history and counters. */
import type { CallbackSearchResponse, HeaderCounters, HistoryResponse, PendenzenResponse } from '@sales-portal/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/helpers';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ demoCrm: true });
});
afterAll(async () => {
  await t?.close();
});

describe('demo dataset', () => {
  it('Pendenzen for every role', async () => {
    for (const user of ['markus', 'manuel', 'nico', 'lukas'] as const) {
      const s = await t.login(user);
      const res = await t.app.inject({ method: 'GET', url: '/api/pendenzen', headers: { cookie: s.cookie } });
      expect(res.statusCode, user).toBe(200);
      const body = res.json() as PendenzenResponse;
      expect(body.warnings).toEqual([]);
      if (user === 'markus') expect(body.items.some((i) => i.kind === 'task' && i.taskType === 'callback')).toBe(true);
      if (user === 'manuel' || user === 'nico') expect(body.items.some((i) => i.kind === 'booking')).toBe(true);
    }
  });

  it('history with missed callback and unknown number; header counters', async () => {
    const s = await t.login('markus');
    const body = (await t.app.inject({ method: 'GET', url: '/api/history', headers: { cookie: s.cookie } })).json() as HistoryResponse;
    expect(body.items.length).toBeGreaterThan(20);
    expect(body.counts.outbound).toBeGreaterThan(0);
    expect(body.counts.unknown_number).toBe(1);
    const counters = (await t.app.inject({ method: 'GET', url: '/api/me/counters', headers: { cookie: s.cookie } })).json() as HeaderCounters;
    expect(counters.missedCallbacks).toBe(body.openMissed);
    expect(counters.pendenzen).toBeGreaterThan(0);
  });

  it('callback search finds a lead of the missed callback', async () => {
    const s = await t.login('markus');
    const history = (await t.app.inject({ method: 'GET', url: '/api/history?categories=callback_missed', headers: { cookie: s.cookie } })).json() as HistoryResponse;
    const missed = history.items.find((i) => i.phoneE164);
    if (!missed) return;
    const res = await t.app.inject({ method: 'GET', url: `/api/history/callback-search?q=${encodeURIComponent(missed.phoneDisplay ?? missed.phoneE164!)}`, headers: { cookie: s.cookie } });
    const body = res.json() as CallbackSearchResponse;
    expect(body.hits.some((h) => h.leadId === missed.leadId)).toBe(true);
  });
});
