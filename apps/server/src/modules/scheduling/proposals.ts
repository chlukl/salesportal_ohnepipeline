/** «3 Vorschläge» (INTENT 6.6): proposals for a month, «anderer», mail draft from the template, sending + change set. */
import {
  addDaysIso,
  atLocalTime,
  buildSchedulingChangeSet,
  checkAttendeeEmail,
  fillTemplate,
  formatProposalsText,
  halfOfDay,
  localIsoDate,
  monthThird,
  personPlaceholders,
  proposeThree,
  selectableMonths,
  swapProposal,
  type DayHalf,
  type IsoDate,
  type Proposal,
  type Slot,
} from '@sales-portal/shared';
import type { RequestAuth } from '../../auth/rbac';
import { audit } from '../../lib/audit';
import { AppError, badRequest, unprocessable } from '../../lib/errors';
import { getSetting } from '../../lib/settings';
import {
  activityOnly,
  getActiveRule,
  getBookingRules,
  getTemplate,
  insertChangeSet,
  internalDomains,
  loadLead,
  resolveSchedulingCall,
  searchSlots,
  type ParticipantInfo,
} from './service';
import { addWorkingDays, applyTaskRulesSafe, type SchedulingDeps } from './util';

export interface ProposalQuery {
  leadId: string;
  month: IsoDate;
  preference: DayHalf;
  extraCall: boolean;
  excludeStarts?: string[];
}

export interface ProposalsResult {
  month: IsoDate;
  proposals: Proposal[];
  /** Ready-to-paste list («– Dienstag, 1. Dezember 2026, 10:00–10:30 Uhr»). */
  text: string;
  draft: { to: string[]; subject: string; body: string };
  participants: ParticipantInfo;
  /** Number of free slots in the month (0 → explain in the UI). */
  freeSlots: number;
  unavailableCalendars: string[];
}

export function monthsInfo(now: Date) {
  return selectableMonths(now);
}

function nextMonthOf(month: IsoDate): IsoDate {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

async function monthSlots(deps: SchedulingDeps, q: ProposalQuery) {
  const now = deps.now();
  const { months } = selectableMonths(now);
  const month = `${q.month.slice(0, 7)}-01`;
  if (!months.includes(month)) throw unprocessable('Bitte einen der angebotenen Monate wählen', 'month_not_selectable');
  const tomorrow = addDaysIso(localIsoDate(now), 1);
  const fromIso = month > tomorrow ? month : tomorrow;
  const from = atLocalTime(fromIso, '00:00');
  const to = atLocalTime(nextMonthOf(month), '00:00');
  return { month, ...(await searchSlots(deps, { from, to, extraCall: q.extraCall })) };
}

async function buildDraft(deps: SchedulingDeps, auth: RequestAuth, leadId: string, proposals: Proposal[]) {
  const lead = await loadLead(deps.adapters, leadId);
  const tpl = await getTemplate(deps.db, 'mail.proposals');
  const text = formatProposalsText(proposals);
  const values = { ...personPlaceholders(lead), Vorschlaege: text, Absender: auth.user.displayName };
  return {
    text,
    draft: {
      to: lead.emailaddress1 ? [lead.emailaddress1] : [],
      subject: fillTemplate(tpl?.subject ?? 'Terminvorschläge – {Firma}', values).trim(),
      body: fillTemplate(tpl?.body ?? 'Guten Tag {Anrede} {Nachname}\n\n{Vorschlaege}\n\nFreundliche Grüsse\n{Absender}', values),
    },
  };
}

export async function computeProposals(deps: SchedulingDeps, auth: RequestAuth, q: ProposalQuery): Promise<ProposalsResult> {
  const rules = await getBookingRules(deps.db);
  const { month, slots, participants, unavailableCalendars } = await monthSlots(deps, q);
  const proposals = proposeThree(slots, { month, preference: q.preference, excludeStarts: q.excludeStarts ?? [] }, deps.now(), rules);
  const { text, draft } = await buildDraft(deps, auth, q.leadId, proposals);
  return { month, proposals, text, draft, participants, freeSlots: slots.length, unavailableCalendars };
}

/** «anderer»: swap one proposal, keep the others (current proposals are re-validated against fresh free/busy). */
export async function swapOne(
  deps: SchedulingDeps,
  auth: RequestAuth,
  q: ProposalQuery & { current: Pick<Slot, 'start' | 'end'>[]; index: number },
): Promise<ProposalsResult> {
  if (q.index < 0 || q.index >= q.current.length) throw badRequest('Ungültiger Vorschlag');
  const rules = await getBookingRules(deps.db);
  const { month, slots, participants, unavailableCalendars } = await monthSlots(deps, q);
  const current: Proposal[] = q.current.map((c) => ({
    slot: { start: new Date(c.start).toISOString(), end: new Date(c.end).toISOString(), attendees: [] },
    monthThird: monthThird(c.start),
    half: halfOfDay(c.start),
  }));
  const next = swapProposal(current, q.index, slots, { month, preference: q.preference, excludeStarts: q.excludeStarts ?? [] }, deps.now(), rules);
  if (!next) throw new AppError(409, 'no_alternative', 'Kein weiterer freier Termin in diesem Monat – anderen Monat oder Zeitwunsch wählen');
  // Kept proposals that are no longer free are reported by the client on send; slots carry their attendees again.
  const withAttendees = next.map((p) => ({ ...p, slot: slots.find((s) => s.start === p.slot.start) ?? p.slot }));
  const { text, draft } = await buildDraft(deps, auth, q.leadId, withAttendees);
  return { month, proposals: withAttendees, text, draft, participants, freeSlots: slots.length, unavailableCalendars };
}

export interface SendProposalsInput {
  leadId: string;
  callSessionId?: string | null;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
}

export interface SendProposalsResult {
  changeSetId: string;
  sentAt: string;
  deliveredTo: string[];
  redirected: boolean;
  taskNote: string | null;
  /** Sent during a call with an open result: call status + follow-up task come with the call result «3 Vorschläge gesendet». */
  withCallResult: boolean;
}

/** Sends the mail from the user's mailbox (only on click), then «3 Vorschläge gesendet» goes to the approval preview. */
export async function sendProposals(deps: SchedulingDeps, auth: RequestAuth, input: SendProposalsInput): Promise<SendProposalsResult> {
  const rules = await getBookingRules(deps.db);
  const lead = await loadLead(deps.adapters, input.leadId);
  // Checked before anything is sent: only the own call of this lead.
  const call = await resolveSchedulingCall(deps.db, auth, input.callSessionId, lead.leadid);
  const withCallResult = !!call?.resultPending;
  const domains = internalDomains(rules);
  const recipients: string[] = [];
  for (const raw of input.to) {
    const check = checkAttendeeEmail(raw, { leadDomain: lead.domain, internalDomains: domains });
    if (!check.ok) throw new AppError(400, 'invalid_recipient', `${check.email || 'Adresse'}: ${check.error}`);
    if (!recipients.some((r) => r.toLowerCase() === check.email.toLowerCase())) recipients.push(check.email);
  }
  if (recipients.length === 0) throw badRequest('Mindestens einen Empfänger angeben');
  const cc: string[] = [];
  for (const raw of input.cc ?? []) {
    const check = checkAttendeeEmail(raw, { leadDomain: lead.domain, internalDomains: [] });
    if (!check.ok) throw new AppError(400, 'invalid_recipient', `${check.email || 'Adresse'}: ${check.error}`);
    cc.push(check.email);
  }

  const sent = await deps.adapters.mail.send(
    { userId: auth.user.id, email: auth.user.email, displayName: auth.user.displayName },
    { to: recipients, cc, subject: input.subject, body: input.body, relatedLeadId: lead.leadid },
  );
  await audit(deps.db, {
    actor: auth.actor,
    action: 'mail.send',
    entity: 'lead',
    entityId: lead.leadid,
    meta: { kind: 'proposals', mailId: sent.id, recipients: recipients.length, redirected: sent.redirected },
  });

  // Follow-up task after 3 working days (REGEL_AUFGABEN). During a call the call result «3 Vorschläge gesendet»
  // proposes it – one task, not one per change set (no second open task per company, max. 3 per day).
  const rule = await getActiveRule(deps.db, 'proposals_sent');
  const now = deps.now();
  let task = null;
  let taskNote: string | null = withCallResult ? 'Anrufstatus und Nachfass-Aufgabe kommen mit dem Anrufergebnis «3 Vorschläge gesendet».' : null;
  if (auth.actor.crmUserId && !withCallResult) {
    const companyLeadIds = (await deps.adapters.crm.getCompanyPersons(lead.leadid).catch(() => []))
      .filter((p) => p.source === 'lead')
      .map((p) => p.id);
    const [companyTasks, ownerTasks, maxPerDay] = await Promise.all([
      Promise.all([...new Set([lead.leadid, ...companyLeadIds])].map((id) => deps.adapters.crm.listTasks({ leadId: id, status: 'open' }))).then((l) => l.flat()),
      deps.adapters.crm.listTasks({ ownerId: auth.actor.crmUserId, status: 'open' }),
      getSetting(deps.db, 'tasks.maxPerPersonPerDay'),
    ]);
    const decision = applyTaskRulesSafe(
      {
        leadId: lead.leadid,
        subject: (rule.followUp.taskSubject ?? 'Nachfassen Terminvorschläge {company}').replace('{company}', lead.companyname),
        dueAt: addWorkingDays(now, rule.followUp.offsetWorkdays ?? 3).toISOString(),
        ownerId: auth.actor.crmUserId,
        taskType: 'follow_up',
        description: `Terminvorschläge vom ${localIsoDate(now).split('-').reverse().join('.')} nachfassen.`,
      },
      { openCompanyTasks: companyTasks, ownerOpenTasks: ownerTasks, maxPerPersonPerDay: maxPerDay, now },
    );
    task = decision.op;
    taskNote = decision.note;
  }

  const built = buildSchedulingChangeSet({
    rule,
    lead,
    actor: auth.actor,
    input: {},
    callSessionId: call?.id ?? null,
    email: { subject: input.subject, text: input.body, to: recipients, sentAt: sent.sentAt },
    task,
  });
  const draft = withCallResult ? activityOnly(built) : built;
  const changeSetId = await insertChangeSet(deps.db, draft, auth.user.id);
  await audit(deps.db, {
    actor: auth.actor,
    action: 'scheduling.proposals_changeset',
    entity: 'lead',
    entityId: lead.leadid,
    changeSetId,
    meta: { mailId: sent.id, withCallResult },
  });
  return { changeSetId, sentAt: sent.sentAt, deliveredTo: sent.deliveredTo, redirected: sent.redirected, taskNote, withCallResult };
}
