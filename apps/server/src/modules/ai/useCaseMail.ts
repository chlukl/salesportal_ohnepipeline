/**
 * Use-Case-Mail (INTENT 6.7, ARCHITECTURE §5.11):
 *
 *   «Mail entwerfen» → KI-Bewertung + Notiz + optional small research (SSRF-safe website fetch; mock: canned text)
 *   → draft from Markus' perspective with 1–2 use cases and a meeting offer (optionally 3 proposals from scheduling)
 *   → Markus edits → «Senden» = his click → MailAdapter.send (redirected to MAIL_TEST_RECIPIENT outside Prod)
 *   → e-mail activity on the lead via a change set (kind `mail`).
 *
 * Drafts are stored as `analyses` rows (kind `use_case_mail`, owner = Markus) so their cost counts for the cap.
 */
import { selectableMonths, USE_CASES, type Analysis, type ChangeSet, type UseCaseMailDraft } from '@sales-portal/shared';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { RequestAuth } from '../../auth/rbac';
import { analyses, callSessions, changeSets } from '../../db/schema';
import { enqueueJob } from '../../jobs/queue';
import { audit } from '../../lib/audit';
import { computeProposals } from '../scheduling/proposals';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { toAnalysis } from './analysis';
import { assertAiBudget } from './budget';
import { assertOwnerOrAdmin, isAdmin, loadAiContext, type AiDeps } from './common';
import { pushChangeSet, rowToChangeSet } from './push';
import { researchWebsite, type ResearchOptions, type ResearchResult } from './research';

export interface DraftMailInput {
  leadId: string;
  callSessionId?: string | null;
  research: boolean;
  includeProposals: boolean;
}

export interface DraftMailResult {
  analysis: Analysis;
  draft: UseCaseMailDraft;
  to: string | null;
  research: { requested: boolean; ok: boolean; source: string | null; error: string | null; demo: boolean };
  proposalsIncluded: boolean;
}

/** 3 proposals from the scheduling module (same rules as «3 Vorschläge»); null when none are available. */
async function proposalsTextFromScheduling(deps: AiDeps, auth: RequestAuth, leadId: string): Promise<string | null> {
  try {
    const { preselected } = selectableMonths(deps.now());
    const res = await computeProposals(
      {
        db: deps.db,
        adapters: deps.adapters,
        calendar: deps.adapters.calendar,
        systemCalendar: deps.adapters.calendar,
        log: deps.log,
        now: deps.now,
        enqueue: (type, payload, options) => enqueueJob(deps.db, type, payload, options),
      },
      auth,
      { leadId, month: preselected, preference: 'any', extraCall: false },
    );
    return res.proposals.length ? res.text.trim().slice(0, 2000) : null;
  } catch (err) {
    deps.log.warn({ err: { message: err instanceof Error ? err.message : String(err) } }, 'proposals for use-case mail not available');
    return null;
  }
}

/** Canned research for the mock/demo mode – no network access. */
export function demoResearch(lead: { companyname: string; kls_industry: string | null; websiteurl: string | null }): ResearchResult {
  const host = (lead.websiteurl ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, '') || 'demo.example.ch';
  return {
    ok: true,
    url: null,
    source: `Website ${host} (Demo-Recherche)`,
    text: `${lead.companyname} ist ein Schweizer KMU${lead.kls_industry ? ` in der Branche ${lead.kls_industry}` : ''}. Auf der Website werden Dienstleistungen, Referenzen und offene Stellen beschrieben. (Demo-Text, keine echte Recherche.)`,
    error: null,
  };
}

async function noteFor(deps: AiDeps, auth: RequestAuth, leadId: string, callSessionId: string | null | undefined): Promise<{ note: string | null; callSessionId: string | null }> {
  if (callSessionId) {
    const [call] = await deps.db.select().from(callSessions).where(eq(callSessions.id, callSessionId));
    if (!call || call.leadId !== leadId) throw notFound('Anruf nicht gefunden');
    if (call.userId !== auth.user.id && !isAdmin(auth)) throw notFound('Anruf nicht gefunden');
    return { note: call.noteDraft, callSessionId: call.id };
  }
  const [latest] = await deps.db
    .select()
    .from(callSessions)
    .where(and(eq(callSessions.leadId, leadId), eq(callSessions.userId, auth.user.id), isNotNull(callSessions.noteDraft)))
    .orderBy(desc(callSessions.createdAt))
    .limit(1);
  return { note: latest?.noteDraft ?? null, callSessionId: latest?.id ?? null };
}

export async function draftUseCaseMail(deps: AiDeps, auth: RequestAuth, input: DraftMailInput, researchOptions?: ResearchOptions): Promise<DraftMailResult> {
  await assertAiBudget(deps.db, deps.now());
  const { note, callSessionId } = await noteFor(deps, auth, input.leadId, input.callSessionId);
  const ctx = await loadAiContext(deps, input.leadId, { note, transcript: null });
  if (ctx.lead.donotemail) throw unprocessable('Dieser Lead möchte keine E-Mails erhalten', 'do_not_email');

  const demo = deps.adapters.ai.mode === 'mock';
  let research: ResearchResult | null = null;
  if (input.research) research = demo ? demoResearch(ctx.lead) : await researchWebsite(ctx.lead.websiteurl, researchOptions);
  const proposalsText = input.includeProposals ? await proposalsTextFromScheduling(deps, auth, input.leadId) : null;

  const out = await deps.adapters.ai.draftUseCaseMail({
    ...ctx,
    research: input.research,
    researchText: research?.ok ? research.text : null,
    researchSource: research?.ok ? research.source : null,
    proposalsText,
    senderName: auth.user.displayName,
  });
  const [row] = await deps.db
    .insert(analyses)
    .values({
      kind: 'use_case_mail',
      leadId: input.leadId,
      callSessionId,
      ownerUserId: auth.user.id,
      status: 'ready',
      model: out.model,
      result: out.result,
      usage: out.usage,
    })
    .returning();
  await audit(deps.db, { actor: auth.actor, action: 'ai.use_case_mail_draft', entity: 'analysis', entityId: row.id, meta: { leadId: input.leadId, research: !!research?.ok } });
  return {
    analysis: toAnalysis(row),
    draft: out.result,
    to: ctx.lead.emailaddress1,
    research: { requested: input.research, ok: !!research?.ok, source: research?.source ?? null, error: research?.error ?? null, demo },
    proposalsIncluded: !!proposalsText,
  };
}

export interface SendMailInput {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
}

export interface SendMailResult {
  analysis: Analysis;
  sent: { id: string; sentAt: string; redirected: boolean; deliveredTo: string[] };
  activity: { status: 'pushed' | 'failed' | 'conflict'; changeSet: ChangeSet; error: string | null };
}

export async function sendUseCaseMail(deps: AiDeps, auth: RequestAuth, analysisId: string, input: SendMailInput): Promise<SendMailResult> {
  const [a] = await deps.db.select().from(analyses).where(eq(analyses.id, analysisId));
  if (!a || a.kind !== 'use_case_mail') throw notFound('Entwurf nicht gefunden');
  assertOwnerOrAdmin(auth, a.ownerUserId);
  if (a.status !== 'ready') throw conflict('Dieses Mail wurde bereits gesendet oder verworfen', 'mail_done');
  const lead = await deps.adapters.crm.getLead(a.leadId);
  if (!lead) throw notFound('Lead nicht gefunden');
  if (lead.donotemail) throw unprocessable('Dieser Lead möchte keine E-Mails erhalten', 'do_not_email');

  const { config } = deps;
  // Defense in depth (ARCHITECTURE §5.11): outside Prod a live mailbox only with a test recipient.
  if (deps.adapters.mail.mode === 'live' && config.environmentLabel !== 'Prod' && !config.mailTestRecipient) {
    throw unprocessable('Mailversand ist ausserhalb von Prod nur mit Testadresse erlaubt', 'mail_test_recipient_missing');
  }
  const to = [...new Set(input.to.map((x) => x.trim().toLowerCase()))];
  if (!to.length) throw badRequest('Mindestens ein Empfänger nötig');

  // The click on «Senden» is Markus' approval (ARCHITECTURE §5.11).
  const sent = await deps.adapters.mail.send(
    { userId: auth.user.id, email: auth.user.email, displayName: auth.user.displayName },
    { to, cc: input.cc ?? [], subject: input.subject, body: input.body, relatedLeadId: a.leadId },
  );

  const now = deps.now();
  const [cs] = await deps.db
    .insert(changeSets)
    .values({
      leadId: a.leadId,
      callSessionId: null,
      kind: 'mail',
      status: 'pending',
      activities: [
        {
          id: 'mail-activity',
          action: 'create',
          type: 'email',
          leadId: a.leadId,
          subject: input.subject,
          text: input.body,
          direction: 'outgoing',
          start: sent.sentAt,
          to,
        },
      ],
      createdBy: auth.user.id,
    })
    .returning();
  let outcome: Awaited<ReturnType<typeof pushChangeSet>>;
  try {
    outcome = await pushChangeSet(deps, cs, auth);
  } catch {
    // The mail is out; the activity stays as a failed change set (Pendenzen › Fehler) and can be retried there.
    const [failed] = await deps.db.update(changeSets).set({ status: 'failed', error: 'CRM nicht erreichbar – bitte erneut versuchen', updatedAt: deps.now() }).where(eq(changeSets.id, cs.id)).returning();
    outcome = { status: 'failed', changeSet: rowToChangeSet(failed), error: failed.error ?? 'Fehlgeschlagen' };
  }

  const draft = a.result as UseCaseMailDraft;
  await deps.db
    .update(analyses)
    .set({
      status: 'approved',
      changeSetId: cs.id,
      reviewedBy: auth.user.id,
      reviewedAt: now,
      updatedAt: now,
      result: { ...draft, subject: input.subject, body: input.body },
    })
    .where(eq(analyses.id, analysisId));
  await audit(deps.db, {
    actor: auth.actor,
    action: 'mail.use_case_sent',
    entity: 'lead',
    entityId: a.leadId,
    changeSetId: cs.id,
    meta: { mailId: sent.id, redirected: sent.redirected, recipients: to.length, useCases: (draft.useCaseIds ?? []).filter((id) => USE_CASES.some((u) => u.id === id)) },
  });
  const [fresh] = await deps.db.select().from(analyses).where(eq(analyses.id, analysisId));
  return {
    analysis: toAnalysis(fresh),
    sent: { id: sent.id, sentAt: sent.sentAt, redirected: sent.redirected, deliveredTo: sent.deliveredTo },
    activity: { status: outcome.status, changeSet: outcome.changeSet, error: outcome.status === 'failed' ? outcome.error : null },
  };
}

export async function discardUseCaseMail(deps: AiDeps, auth: RequestAuth, analysisId: string): Promise<void> {
  const [a] = await deps.db.select().from(analyses).where(eq(analyses.id, analysisId));
  if (!a || a.kind !== 'use_case_mail') throw notFound('Entwurf nicht gefunden');
  assertOwnerOrAdmin(auth, a.ownerUserId);
  if (a.status !== 'ready') return;
  await deps.db.update(analyses).set({ status: 'rejected', reviewedBy: auth.user.id, reviewedAt: deps.now(), updatedAt: deps.now() }).where(eq(analyses.id, analysisId));
}
