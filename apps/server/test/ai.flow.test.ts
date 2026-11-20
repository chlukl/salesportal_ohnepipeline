/**
 * ai module – flows against in-memory PGlite: transcript → analysis → review/approve/dismiss, cost cap, use-case mail,
 * briefing delivery (calendar / mail), access control over HTTP, Vera webhook plugin.
 */
import type { ApplyResult, ChangeSet } from '@sales-portal/shared';
import { and, eq, isNull } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestAuth } from '../src/auth/rbac';
import { analyses, auditLog, bookings, callSessions, changeSets, jobs, mockCalendarEvents, mockCrmActivities, mockCrmLeads, mockOutbox, transcripts } from '../src/db/schema';
import { DEMO_USERS } from '../src/db/seed/users';
import type { Adapters } from '../src/integrations';
import type { CrmAdapter } from '../src/integrations/crm/types';
import { createLogger } from '../src/lib/logger';
import { setSetting } from '../src/lib/settings';
import { analyzeCallJob, approveAnalysis, countReadyAnalyses, dismissAnalysis, listReviewItems } from '../src/modules/ai/analysis';
import {
  briefingMailJob,
  buildBriefingJob,
  deleteBriefingForBooking,
  deliverBriefingJob,
  JOB_BRIEFING_MAIL,
  updateBriefingForBooking,
} from '../src/modules/ai/briefing';
import { SYSTEM_ACTOR, type AiDeps } from '../src/modules/ai/common';
import { fetchTranscriptJob, onCallSessionEnded, sweepEndedCalls, syncCallDurationJob } from '../src/modules/ai/transcripts';
import { draftUseCaseMail } from '../src/modules/ai/useCaseMail';
import { signVeraPayload, veraWebhookPlugin } from '../src/modules/ai/veraWebhook';
import { createTestApp, type TestApp } from './helpers';

let t: TestApp;
const user = (key: 'lukas' | 'markus' | 'manuel' | 'nico') => DEMO_USERS.find((u) => u.key === key)!;

function authFor(key: 'lukas' | 'markus' | 'manuel' | 'nico', effective?: RequestAuth['effectiveRoles']): RequestAuth {
  const u = user(key);
  return {
    sessionIdHash: 'test',
    csrfToken: 'test',
    user: { id: u.id, email: u.email, displayName: u.displayName, crmUserId: u.crmUserId },
    roles: u.roles,
    effectiveRoles: effective ?? u.roles,
    viewAs: null,
    isRealAdmin: u.roles.includes('admin'),
    actor: { kind: 'user', userId: u.id, displayName: u.displayName, crmUserId: u.crmUserId, email: u.email },
  };
}

const applied: ChangeSet[] = [];
let applyOk = true;

/** System adapters with a fake `applyChangeSet` (the mock CRM push belongs to the changesets implementer). */
function adaptersWithFakePush(base: Adapters): Adapters {
  const crm = new Proxy(base.crm, {
    get(target, prop, receiver) {
      if (prop === 'applyChangeSet') {
        return async (cs: ChangeSet): Promise<ApplyResult> => {
          applied.push(cs);
          return {
            ok: applyOk,
            results: [
              ...cs.operations.map((o) => ({ opId: o.id, kind: 'field' as const, ok: applyOk, error: applyOk ? null : 'CRM-Fehler' })),
              ...cs.activities.map((a) => ({ opId: a.id, kind: 'activity' as const, ok: applyOk, createdId: a.action === 'create' ? 'act-new' : null })),
            ],
          };
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as CrmAdapter;
  return { ...base, crm };
}

function deps(now = new Date()): AiDeps {
  return { config: t.ctx.config, db: t.ctx.db, adapters: adaptersWithFakePush(t.ctx.adapters.system()), log: createLogger('silent'), now: () => now };
}

let leadSeq = 0;
async function insertLead(over: Partial<typeof mockCrmLeads.$inferInsert> = {}): Promise<string> {
  const leadid = `ai-lead-${++leadSeq}`;
  await t.ctx.db.insert(mockCrmLeads).values({
    leadid,
    companyname: `Testfirma ${leadSeq} AG`,
    firstname: 'Hans',
    lastname: 'Muster',
    jobtitle: 'Geschäftsführer',
    emailaddress1: `hans${leadSeq}@muster.example.ch`,
    telephone1: '+41 61 555 01 01',
    websiteurl: 'https://muster.example.ch',
    domain: 'muster.example.ch',
    numberofemployees: 40,
    kls_industry: 'Maschinenbau',
    kls_ki_bewertung: 'Stand: 11.2026\nGrade: B\nEinstieg: Offerten dauern zu lange.\nStichworte: Offerten, ERP',
    ...over,
  });
  return leadid;
}

async function insertCall(leadId: string, over: Partial<typeof callSessions.$inferInsert> = {}): Promise<string> {
  const now = Date.now();
  const [row] = await t.ctx.db
    .insert(callSessions)
    .values({
      userId: user('markus').id,
      leadId,
      leadName: 'Hans Muster',
      companyName: 'Testfirma AG',
      status: 'completed',
      dialedAt: new Date(now - 5 * 60_000),
      connectedAt: new Date(now - 4 * 60_000),
      endedAt: new Date(now - 60_000),
      durationSec: 180,
      durationSource: 'clicks',
      veraEnabled: true,
      noteDraft: 'Interessiert an Offerten, bitte Unterlagen per Mail. 55 Mitarbeitende.',
      resultGroup: 'info_mail',
      ...over,
    })
    .returning({ id: callSessions.id });
  return row.id;
}

async function insertPhonecall(leadId: string): Promise<string> {
  const id = `pc-${leadId}`;
  await t.ctx.db.insert(mockCrmActivities).values({
    activityid: id,
    activitytype: 'phonecall',
    regardingLeadId: leadId,
    subject: 'Anruf Testfirma – Mail mit Infos gewünscht',
    description: 'Interessiert an Offerten, bitte Unterlagen per Mail.',
    direction: 'outgoing',
    ownerid: user('markus').crmUserId,
    actualstart: new Date(Date.now() - 4 * 60_000),
    kls_anrufergebnis: 845140005,
  });
  return id;
}

/** Runs the full transcript + analysis flow for a new call and returns the ids. */
async function analysedCall(opts: { pushed?: boolean } = {}) {
  const leadId = await insertLead();
  const phonecallId = opts.pushed === false ? null : await insertPhonecall(leadId);
  const callId = await insertCall(leadId, { crmPhonecallId: phonecallId });
  const analysisId = (await onCallSessionEnded(deps(), callId))!;
  expect(await fetchTranscriptJob(deps(), analysisId)).toBe('stored');
  expect(await analyzeCallJob(deps(), analysisId, true)).toBe('ready');
  return { leadId, callId, analysisId, phonecallId };
}

beforeAll(async () => {
  t = await createTestApp({ env: { MAIL_TEST_RECIPIENT: 'test-inbox@example.ch' } });
});
afterAll(async () => {
  await t?.close();
});
beforeEach(() => {
  applied.length = 0;
  applyOk = true;
});

describe('transcript flow (Vera)', () => {
  it('ended call with Vera on → transcript stored with retention → analysis ready with draft change set', async () => {
    const { callId, analysisId } = await analysedCall();
    const [tr] = await t.ctx.db.select().from(transcripts).where(eq(transcripts.callSessionId, callId));
    expect(tr.source).toBe('mock');
    expect(tr.segments.length).toBeGreaterThan(3);
    const days = (tr.deleteAfter.getTime() - tr.fetchedAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);

    const [call] = await t.ctx.db.select().from(callSessions).where(eq(callSessions.id, callId));
    expect(call.durationSource).toBe('vera');
    expect(call.durationSec).toBeGreaterThanOrEqual(180);

    const [a] = await t.ctx.db.select().from(analyses).where(eq(analyses.id, analysisId));
    expect(a.status).toBe('ready');
    expect(a.ownerUserId).toBe(user('markus').id);
    const [cs] = await t.ctx.db.select().from(changeSets).where(eq(changeSets.id, a.changeSetId!));
    expect(cs).toMatchObject({ kind: 'analysis', status: 'draft' });
    expect(cs.activities[0]).toMatchObject({ action: 'update', type: 'phonecall' });
    // Idempotent: a second «ended» signal does not create a second analysis.
    expect(await onCallSessionEnded(deps(), callId)).toBe(analysisId);
  });

  it('Vera off → no analysis at all', async () => {
    const leadId = await insertLead();
    const callId = await insertCall(leadId, { veraEnabled: false });
    expect(await onCallSessionEnded(deps(), callId)).toBeNull();
    expect(await sweepEndedCalls(deps())).toBe(0);
  });

  it('no transcript within the timeout → analysis dropped silently', async () => {
    const leadId = await insertLead();
    const callId = await insertCall(leadId);
    const analysisId = (await onCallSessionEnded(deps(), callId))!;
    const later = new Date(Date.now() + 31 * 60_000);
    expect(await fetchTranscriptJob(deps(later), analysisId)).toBe('skipped');
    const [a] = await t.ctx.db.select().from(analyses).where(eq(analyses.id, analysisId));
    expect(a.status).toBe('skipped');
    expect(await countReadyAnalyses(deps(), user('markus').id)).toBeGreaterThanOrEqual(0);
  });

  it('respects the admin timeout setting', async () => {
    await setSetting(t.ctx.db, 'analysis.timeoutMinutes', 1, SYSTEM_ACTOR);
    try {
      const leadId = await insertLead();
      const callId = await insertCall(leadId, { endedAt: new Date(Date.now() - 2 * 60_000) });
      const analysisId = (await onCallSessionEnded(deps(), callId))!;
      expect(await fetchTranscriptJob(deps(), analysisId)).toBe('skipped');
    } finally {
      await setSetting(t.ctx.db, 'analysis.timeoutMinutes', 30, SYSTEM_ACTOR);
    }
  });

  it('transcript not ready yet → polls again later', async () => {
    const leadId = await insertLead();
    const callId = await insertCall(leadId, { endedAt: new Date() });
    const analysisId = (await onCallSessionEnded(deps(), callId))!;
    expect(await fetchTranscriptJob(deps(), analysisId)).toBe('pending');
    const queued = await t.ctx.db.select().from(jobs).where(and(eq(jobs.type, 'ai.fetch_transcript'), eq(jobs.status, 'queued')));
    expect(queued.some((j) => (j.payload as { analysisId: string }).analysisId === analysisId)).toBe(true);
  });

  it('sweep picks up ended calls the calls module did not report', async () => {
    const leadId = await insertLead();
    const callId = await insertCall(leadId);
    expect(await sweepEndedCalls(deps())).toBeGreaterThanOrEqual(1);
    const [a] = await t.ctx.db.select().from(analyses).where(eq(analyses.callSessionId, callId));
    expect(a.status).toBe('pending');
  });

  it('writes Vera duration to the CRM phone call in the background once the call is pushed', async () => {
    const { callId, phonecallId } = await analysedCall({ pushed: false });
    const [tr] = await t.ctx.db.select().from(transcripts).where(eq(transcripts.callSessionId, callId));
    expect(await syncCallDurationJob(deps(), callId, tr.id)).toBe('waiting');
    expect(phonecallId).toBeNull();
    const [call] = await t.ctx.db.select().from(callSessions).where(eq(callSessions.id, callId));
    const pc = await insertPhonecall(call.leadId!);
    await t.ctx.db.update(callSessions).set({ crmPhonecallId: pc }).where(eq(callSessions.id, callId));
    expect(await syncCallDurationJob(deps(), callId, tr.id)).toBe('updated');
    const [act] = await t.ctx.db.select().from(mockCrmActivities).where(eq(mockCrmActivities.activityid, pc));
    expect(act.durationSec).toBe(tr.durationSec);
  });
});

describe('Analysen zur Freigabe', () => {
  it('«Ergänzen» pushes summary + interest to the phone call; proposals only when ticked', async () => {
    const { analysisId, phonecallId } = await analysedCall();
    const items = await listReviewItems(deps(), user('markus').id);
    const item = items.find((i) => i.analysis.id === analysisId)!;
    expect(item.call?.pushed).toBe(true);
    const proposalIds = item.changeSet!.operations.map((o) => o.id);
    expect(proposalIds).toContain('ai-lead-numberofemployees'); // «55 Mitarbeitende» in the note

    const res = await approveAnalysis(deps(), authFor('markus'), analysisId, { acceptOpIds: [], acceptLeadCreate: false });
    expect(res.status).toBe('approved');
    expect(applied).toHaveLength(1);
    const cs = applied[0];
    expect(cs.kind).toBe('analysis');
    expect(cs.operations).toEqual([]); // nothing ticked → only the phone call
    expect(cs.activities[0]).toMatchObject({ action: 'update', activityId: phonecallId });
    expect(cs.activities[0].text).toContain('Interessiert an Offerten');
    expect(cs.activities[0].text).toContain('KI-Zusammenfassung:');
    const [a] = await t.ctx.db.select().from(analyses).where(eq(analyses.id, analysisId));
    expect(a.status).toBe('approved');
    expect(a.reviewedBy).toBe(user('markus').id);
    const [row] = await t.ctx.db.select().from(changeSets).where(eq(changeSets.id, a.changeSetId!));
    expect(row.status).toBe('pushed');
    const logs = await t.ctx.db.select().from(auditLog).where(eq(auditLog.entityId, analysisId));
    expect(logs.map((l) => l.action)).toContain('ai.analysis_approve');
    await expect(approveAnalysis(deps(), authFor('markus'), analysisId, { acceptOpIds: [], acceptLeadCreate: false })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('cannot add to a call whose result is not in the CRM yet', async () => {
    const { analysisId } = await analysedCall({ pushed: false });
    await expect(approveAnalysis(deps(), authFor('markus'), analysisId, { acceptOpIds: [], acceptLeadCreate: false })).rejects.toMatchObject({
      statusCode: 409,
      code: 'call_not_pushed',
    });
  });

  it('conflict: field changed in the CRM since the analysis → decision needed, then overwrite', async () => {
    const { analysisId, leadId } = await analysedCall();
    await t.ctx.db.update(mockCrmLeads).set({ numberofemployees: 48 }).where(eq(mockCrmLeads.leadid, leadId));
    const first = await approveAnalysis(deps(), authFor('markus'), analysisId, { acceptOpIds: ['ai-lead-numberofemployees'], acceptLeadCreate: false });
    expect(first.status).toBe('conflict');
    if (first.status !== 'conflict') return;
    expect(first.conflicts[0]).toMatchObject({ field: 'numberofemployees', draftValue: 40, crmNow: 48, newValue: 55 });
    expect(applied).toHaveLength(0);
    const second = await approveAnalysis(deps(), authFor('markus'), analysisId, {
      acceptOpIds: ['ai-lead-numberofemployees'],
      acceptLeadCreate: false,
      resolutions: { 'ai-lead-numberofemployees': 'overwrite' },
    });
    expect(second.status).toBe('approved');
    expect(applied[0].operations.map((o) => o.id)).toEqual(['ai-lead-numberofemployees']);
  });

  it('failed push keeps the draft (nothing lost) and the analysis stays open', async () => {
    const { analysisId } = await analysedCall();
    applyOk = false;
    await expect(approveAnalysis(deps(), authFor('markus'), analysisId, { acceptOpIds: ['ai-lead-numberofemployees'], acceptLeadCreate: false })).rejects.toMatchObject({ statusCode: 502 });
    const [a] = await t.ctx.db.select().from(analyses).where(eq(analyses.id, analysisId));
    expect(a.status).toBe('ready');
    const [cs] = await t.ctx.db.select().from(changeSets).where(eq(changeSets.id, a.changeSetId!));
    expect(cs.status).toBe('failed');
    expect(cs.operations.length).toBeGreaterThan(0);
  });

  it('draft step fails → analysis stays running with its result; retry reuses it (no 2nd AI call) and sets ready + draft together', async () => {
    const leadId = await insertLead();
    const phonecallId = await insertPhonecall(leadId);
    const callId = await insertCall(leadId, { crmPhonecallId: phonecallId });
    const analysisId = (await onCallSessionEnded(deps(), callId))!;
    expect(await fetchTranscriptJob(deps(), analysisId)).toBe('stored');

    let aiCalls = 0;
    let failTx = true;
    const flaky = (): AiDeps => {
      const base = deps();
      const ai = new Proxy(base.adapters.ai, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver);
          if (prop === 'analyzeCall') {
            return (...args: unknown[]) => {
              aiCalls++;
              return (v as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      const db = new Proxy(base.db, {
        get(target, prop, receiver) {
          if (prop === 'transaction' && failTx) {
            return async () => {
              throw new Error('DB weg');
            };
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      return { ...base, db, adapters: { ...base.adapters, ai } };
    };

    await expect(analyzeCallJob(flaky(), analysisId, false)).rejects.toThrow('DB weg');
    let [a] = await t.ctx.db.select().from(analyses).where(eq(analyses.id, analysisId));
    expect(a.status).toBe('running'); // never «ready» without its draft
    expect(a.changeSetId).toBeNull();
    expect(a.result).not.toBeNull(); // paid result kept
    expect(await t.ctx.db.select().from(changeSets).where(eq(changeSets.leadId, leadId))).toHaveLength(0);

    failTx = false;
    expect(await analyzeCallJob(flaky(), analysisId, false)).toBe('ready');
    expect(aiCalls).toBe(1);
    [a] = await t.ctx.db.select().from(analyses).where(eq(analyses.id, analysisId));
    expect(a.status).toBe('ready');
    expect(a.changeSetId).not.toBeNull();
    const res = await approveAnalysis(deps(), authFor('markus'), analysisId, { acceptOpIds: [], acceptLeadCreate: false });
    expect(res.status).toBe('approved');
  });

  it('a «ready» analysis without draft (older data) gets its draft rebuilt on approval instead of being stuck', async () => {
    const { analysisId } = await analysedCall();
    const [before] = await t.ctx.db.select().from(analyses).where(eq(analyses.id, analysisId));
    await t.ctx.db.update(changeSets).set({ status: 'discarded' }).where(eq(changeSets.id, before.changeSetId!));
    await t.ctx.db.update(analyses).set({ changeSetId: null }).where(eq(analyses.id, analysisId));
    const res = await approveAnalysis(deps(), authFor('markus'), analysisId, { acceptOpIds: [], acceptLeadCreate: false });
    expect(res.status).toBe('approved');
    const [after] = await t.ctx.db.select().from(analyses).where(eq(analyses.id, analysisId));
    expect(after.status).toBe('approved');
    expect(after.changeSetId).not.toBeNull();
    expect(after.changeSetId).not.toBe(before.changeSetId);
  });

  it('only the owner (or admin) may review; dismiss discards the draft', async () => {
    const { analysisId } = await analysedCall();
    await expect(dismissAnalysis(deps(), authFor('nico'), analysisId)).rejects.toMatchObject({ statusCode: 404 });
    // Admin viewing as coldcaller is not admin anymore.
    await expect(dismissAnalysis(deps(), authFor('lukas', ['coldcaller']), analysisId)).rejects.toMatchObject({ statusCode: 404 });
    const dismissed = await dismissAnalysis(deps(), authFor('markus'), analysisId);
    expect(dismissed.status).toBe('rejected');
    const [cs] = await t.ctx.db.select().from(changeSets).where(eq(changeSets.id, dismissed.changeSetId!));
    expect(cs.status).toBe('discarded');
  });

  it('monthly cost cap: analysis fails visibly, drafts are refused', async () => {
    const leadId = await insertLead();
    const callId = await insertCall(leadId);
    const analysisId = (await onCallSessionEnded(deps(), callId))!;
    expect(await fetchTranscriptJob(deps(), analysisId)).toBe('stored');
    const [spent] = await t.ctx.db
      .insert(analyses)
      .values({ kind: 'briefing', leadId, status: 'skipped', usage: { inputTokens: 1, outputTokens: 1, costUsd: 1000 } })
      .returning({ id: analyses.id });
    try {
      expect(await analyzeCallJob(deps(), analysisId, false)).toBe('failed');
      const [a] = await t.ctx.db.select().from(analyses).where(eq(analyses.id, analysisId));
      expect(a.error).toMatch(/Budget/);
      await expect(draftUseCaseMail(deps(), authFor('markus'), { leadId, research: false, includeProposals: false })).rejects.toMatchObject({
        statusCode: 429,
        code: 'ai_budget_exceeded',
      });
    } finally {
      await t.ctx.db.delete(analyses).where(eq(analyses.id, spent.id));
    }
  });
});

describe('HTTP: analyses, counter, use-case mail', () => {
  it('review list and header counter for Markus; sales has no access; admin may look at Markus', async () => {
    const { analysisId } = await analysedCall();
    const markus = await t.login('markus');
    const list = await t.app.inject({ method: 'GET', url: '/api/ai/analyses/review', headers: { cookie: markus.cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.some((i: { analysis: { id: string } }) => i.analysis.id === analysisId)).toBe(true);
    const counters = await t.app.inject({ method: 'GET', url: '/api/me/counters', headers: { cookie: markus.cookie } });
    expect(counters.json().analysen).toBeGreaterThanOrEqual(1);

    const manuel = await t.login('manuel');
    expect((await t.app.inject({ method: 'GET', url: '/api/ai/analyses/review', headers: { cookie: manuel.cookie } })).statusCode).toBe(403);
    const lukas = await t.login('lukas');
    const asAdmin = await t.app.inject({ method: 'GET', url: `/api/ai/analyses/review?userId=${user('markus').id}`, headers: { cookie: lukas.cookie } });
    expect(asAdmin.statusCode).toBe(200);
    const other = await t.app.inject({ method: 'GET', url: `/api/ai/analyses/review?userId=${user('lukas').id}`, headers: { cookie: markus.cookie } });
    expect(other.statusCode).toBe(403);
    const detail = await t.app.inject({ method: 'GET', url: `/api/ai/analyses/${analysisId}`, headers: { cookie: lukas.cookie } });
    expect(detail.statusCode).toBe(200);
    const dismiss = await t.app.inject({ method: 'POST', url: `/api/ai/analyses/${analysisId}/dismiss`, headers: markus.headers, payload: {} });
    expect(dismiss.statusCode).toBe(200);
  });

  it('use-case mail: draft (demo research) → edit → send to the test recipient + e-mail activity', async () => {
    const leadId = await insertLead();
    await insertCall(leadId);
    const markus = await t.login('markus');
    const draft = await t.app.inject({ method: 'POST', url: '/api/ai/use-case-mail/draft', headers: markus.headers, payload: { leadId, research: true, includeProposals: true } });
    expect(draft.statusCode).toBe(200);
    const d = draft.json();
    expect(d.proposalsIncluded).toBe(true);
    expect(d.draft.body).toContain('Passt Ihnen einer dieser Termine?');
    expect(d.research).toMatchObject({ requested: true, ok: true, demo: true });
    expect(d.draft.useCaseIds.length).toBeGreaterThanOrEqual(1);
    expect(d.draft.useCaseIds.length).toBeLessThanOrEqual(2);
    expect(d.draft.sources.length).toBeGreaterThan(0);
    expect(d.draft.body).toContain('Markus');
    expect(d.to).toBe(`hans${leadSeq}@muster.example.ch`);

    const badSubject = await t.app.inject({
      method: 'POST',
      url: `/api/ai/use-case-mail/${d.analysis.id}/send`,
      headers: markus.headers,
      payload: { to: [d.to], subject: 'Hallo\nBcc: x@example.ch', body: 'x' },
    });
    expect(badSubject.statusCode).toBe(400);

    const sent = await t.app.inject({
      method: 'POST',
      url: `/api/ai/use-case-mail/${d.analysis.id}/send`,
      headers: markus.headers,
      payload: { to: [d.to], subject: 'Offerten schneller mit KI', body: `${d.draft.body}\n\nPS: angepasst` },
    });
    expect(sent.statusCode).toBe(200);
    const s = sent.json();
    expect(s.sent.redirected).toBe(true);
    expect(s.sent.deliveredTo).toEqual(['test-inbox@example.ch']);
    expect(['pushed', 'failed']).toContain(s.activity.status); // mock CRM push belongs to the changesets implementer
    expect(s.activity.changeSet.activities[0]).toMatchObject({ action: 'create', type: 'email', subject: 'Offerten schneller mit KI' });
    const [mail] = await t.ctx.db.select().from(mockOutbox).where(eq(mockOutbox.relatedLeadId, leadId));
    expect(mail.originalTo).toEqual([d.to]);
    expect(mail.body).toContain('PS: angepasst');

    const again = await t.app.inject({ method: 'POST', url: `/api/ai/use-case-mail/${d.analysis.id}/send`, headers: markus.headers, payload: { to: [d.to], subject: 'x', body: 'x' } });
    expect(again.statusCode).toBe(409);
  });

  it('use-case mail: refused for «keine E-Mails», for sales, and for other users\' drafts', async () => {
    const markus = await t.login('markus');
    const blocked = await insertLead({ donotemail: true });
    const r = await t.app.inject({ method: 'POST', url: '/api/ai/use-case-mail/draft', headers: markus.headers, payload: { leadId: blocked } });
    expect(r.statusCode).toBe(422);
    const manuel = await t.login('manuel');
    const leadId = await insertLead();
    expect((await t.app.inject({ method: 'POST', url: '/api/ai/use-case-mail/draft', headers: manuel.headers, payload: { leadId } })).statusCode).toBe(403);

    const lukas = await t.login('lukas');
    const own = await t.app.inject({ method: 'POST', url: '/api/ai/use-case-mail/draft', headers: lukas.headers, payload: { leadId } });
    expect(own.statusCode).toBe(200);
    const foreign = await t.app.inject({
      method: 'POST',
      url: `/api/ai/use-case-mail/${own.json().analysis.id}/send`,
      headers: markus.headers,
      payload: { to: ['a@example.ch'], subject: 'x', body: 'x' },
    });
    expect(foreign.statusCode).toBe(404);
  });
});

describe('briefing', () => {
  async function insertBooking(over: Partial<typeof bookings.$inferInsert> = {}) {
    const leadId = await insertLead();
    const start = new Date(Date.now() + 10 * 86_400_000);
    const [b] = await t.ctx.db
      .insert(bookings)
      .values({
        bookingRef: `KLS-${leadSeq}-${Date.now()}`,
        leadId,
        leadName: 'Hans Muster',
        companyName: `Testfirma ${leadSeq} AG`,
        salesUserId: user('manuel').id,
        specialistUserId: user('nico').id,
        startAt: start,
        endAt: new Date(start.getTime() + 30 * 60_000),
        subject: `Vorstellung der Kallysoft Informatik AG als KI-Spezialist – Testfirma ${leadSeq} AG`,
        createdBy: user('markus').id,
        ...over,
      })
      .returning();
    return b;
  }

  const briefingEvents = (bookingRef: string) =>
    t.ctx.db
      .select()
      .from(mockCalendarEvents)
      .then((rows) => rows.filter((r) => r.extendedProperties.KlsTerminId === bookingRef && r.extendedProperties.KlsRolle === 'briefing'));

  it('without preparation: calendar entries for sales + Nico (free, category, subject without «Vorstellung»); moves and deletes with the booking', async () => {
    const b = await insertBooking();
    expect(await buildBriefingJob(deps(), b.id)).toBe('built');
    expect(await deliverBriefingJob(deps(), b.id)).toBe('calendar');
    let events = await briefingEvents(b.bookingRef);
    expect(events.map((e) => e.mailbox).sort()).toEqual([user('manuel').email, user('nico').email].sort());
    for (const e of events) {
      expect(e.showAs).toBe('free');
      expect(e.categories).toEqual(['Kallysoft Briefing']);
      expect(e.subject).not.toMatch(/Vorstellung der Kallysoft/);
      expect(e.startAt.getTime()).toBe(b.startAt.getTime());
      expect(e.body).toContain('Einstiegsfragen');
    }
    // Idempotent delivery → still two entries.
    await deliverBriefingJob(deps(), b.id);
    expect((await briefingEvents(b.bookingRef)).filter((e) => !e.deletedAt)).toHaveLength(2);

    const moved = new Date(b.startAt.getTime() + 86_400_000);
    await t.ctx.db.update(bookings).set({ startAt: moved, endAt: new Date(moved.getTime() + 30 * 60_000), status: 'rescheduled' }).where(eq(bookings.id, b.id));
    await updateBriefingForBooking(deps(), b.id);
    events = (await briefingEvents(b.bookingRef)).filter((e) => !e.deletedAt);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.startAt.getTime() === moved.getTime())).toBe(true);

    await t.ctx.db.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, b.id));
    await deleteBriefingForBooking(deps(), b.id);
    expect((await briefingEvents(b.bookingRef)).filter((e) => !e.deletedAt)).toHaveLength(0);
    const [after] = await t.ctx.db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after.briefingEventIds).toEqual([]);
  });

  it('with preparation: mail 1 week before (immediately when closer), sent once to sales + Nico', async () => {
    const far = await insertBooking({ needsPreparation: true, preparationNote: 'Demo mit Offerten vorbereiten' });
    await buildBriefingJob(deps(), far.id);
    expect(await deliverBriefingJob(deps(), far.id)).toBe('mail_scheduled');
    const [farJob] = await t.ctx.db.select().from(jobs).where(and(eq(jobs.dedupeKey, `${JOB_BRIEFING_MAIL}:${far.id}`), eq(jobs.status, 'queued')));
    expect(Math.abs(farJob.runAt.getTime() - (far.startAt.getTime() - 7 * 86_400_000))).toBeLessThan(5_000);
    expect(await briefingEvents(far.bookingRef)).toHaveLength(0);

    const soonStart = new Date(Date.now() + 2 * 86_400_000);
    const soon = await insertBooking({ needsPreparation: true, startAt: soonStart, endAt: new Date(soonStart.getTime() + 1_800_000) });
    await buildBriefingJob(deps(), soon.id);
    await deliverBriefingJob(deps(), soon.id);
    const [soonJob] = await t.ctx.db.select().from(jobs).where(and(eq(jobs.dedupeKey, `${JOB_BRIEFING_MAIL}:${soon.id}`), eq(jobs.status, 'queued')));
    expect(soonJob.runAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    expect(await briefingMailJob(deps(), soon.id)).toBe('sent');
    expect(await briefingMailJob(deps(), soon.id)).toBe('skipped'); // only once
    const mails = await t.ctx.db.select().from(mockOutbox).where(eq(mockOutbox.relatedLeadId, soon.leadId));
    expect(mails).toHaveLength(1);
    expect(mails[0].originalTo?.sort()).toEqual([user('manuel').email, user('nico').email].sort());
    expect(mails[0].subject).toMatch(/^Vorbereitung: Briefing/);

    // Too early for the far booking → re-scheduled, nothing sent.
    expect(await briefingMailJob(deps(), far.id)).toBe('rescheduled');
    const cancelled = await t.ctx.db.select().from(jobs).where(and(eq(jobs.dedupeKey, `${JOB_BRIEFING_MAIL}:${far.id}`), isNull(jobs.finishedAt)));
    expect(cancelled.length).toBeGreaterThan(0);
  });

  it('HTTP: view and status with object-level access', async () => {
    const b = await insertBooking({ origin: 'campaign' });
    await buildBriefingJob(deps(), b.id);
    const manuel = await t.login('manuel');
    const view = await t.app.inject({ method: 'GET', url: `/api/ai/briefings/${b.id}`, headers: { cookie: manuel.cookie } });
    expect(view.statusCode).toBe(200);
    expect(view.json().briefing.company).toContain('Testfirma');
    expect(view.json().canUpdateStatus).toBe(true);

    const markus = await t.login('markus');
    expect((await t.app.inject({ method: 'GET', url: `/api/ai/briefings/${b.id}`, headers: { cookie: markus.cookie } })).statusCode).toBe(200);
    const markusStatus = await t.app.inject({ method: 'POST', url: `/api/ai/briefings/${b.id}/status`, headers: markus.headers, payload: { status: 'read' } });
    expect(markusStatus.statusCode).toBe(403);

    expect((await t.app.inject({ method: 'POST', url: `/api/ai/briefings/${b.id}/status`, headers: manuel.headers, payload: { status: 'prepared' } })).json().status).toBe('prepared');
    // «gelesen» never downgrades «Vorbereitung erledigt».
    expect((await t.app.inject({ method: 'POST', url: `/api/ai/briefings/${b.id}/status`, headers: manuel.headers, payload: { status: 'read' } })).json().status).toBe('prepared');

    const other = await insertBooking({ salesUserId: user('lukas').id });
    expect((await t.app.inject({ method: 'GET', url: `/api/ai/briefings/${other.id}`, headers: { cookie: manuel.cookie } })).statusCode).toBe(404);
    const nico = await t.login('nico');
    expect((await t.app.inject({ method: 'GET', url: `/api/ai/briefings/${other.id}`, headers: { cookie: nico.cookie } })).statusCode).toBe(200);
  });
});

describe('Vera webhook plugin (HMAC + replay protection)', () => {
  it('accepts signed notifications once, rejects replays and bad signatures', async () => {
    const secret = 'webhook-secret-for-tests-0123456789';
    const leadId = await insertLead();
    const callId = await insertCall(leadId);
    const [call] = await t.ctx.db.select().from(callSessions).where(eq(callSessions.id, callId));
    const app = Fastify();
    await app.register(veraWebhookPlugin({ secret, deps: () => deps(), routeConfig: {} }), { prefix: '/api/ai' });
    await app.ready();
    const payload = JSON.stringify({ event: 'transcript.ready', callRef: 'vera-123', userEmail: user('markus').email, startedAt: call.connectedAt!.toISOString() });
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = (delivery: string, sig?: string) => ({
      'content-type': 'application/json',
      'x-vera-timestamp': ts,
      'x-vera-delivery': delivery,
      'x-vera-signature': sig ?? signVeraPayload(secret, ts, delivery, payload),
    });
    const ok = await app.inject({ method: 'POST', url: '/api/ai/vera/webhook', headers: headers('delivery-aaaa-1'), payload });
    expect(ok.statusCode).toBe(202);
    expect(ok.json().matched).toBe(true);
    const [linked] = await t.ctx.db.select().from(callSessions).where(eq(callSessions.id, callId));
    expect(linked.transcriptRef).toBe('vera-123');

    const replay = await app.inject({ method: 'POST', url: '/api/ai/vera/webhook', headers: headers('delivery-aaaa-1'), payload });
    expect(replay.statusCode).toBe(409);
    const forged = await app.inject({ method: 'POST', url: '/api/ai/vera/webhook', headers: headers('delivery-bbbb-2', 'sha256=00'), payload });
    expect(forged.statusCode).toBe(401);
    await app.close();
  });
});
