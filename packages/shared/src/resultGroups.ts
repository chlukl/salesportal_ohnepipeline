/**
 * Result-group engine (INTENT 6.5): rule + lead + wrap-up input → ChangeSet draft (preview alt → neu).
 *
 * OWNER: coldcall implementer (leads/workspace/calls/changesets). Default rules (data) live in `resultGroupDefaults.ts`.
 *
 * Rules implemented here (INTENT 6.5 «Immer, bei jeder Gruppe»):
 * - phone call activity with kls_anrufergebnis and the note as text (not a «Sales-Portal:» note)
 * - owner → caller when someone was reached (rule.setsOwnerToCaller)
 * - Neu (1) → Kontaktiert (2) when reached; «Austausch» / «Zweitkontakt» stay
 * - tasks only via taskRules.ts (no 2nd open task per company, max 3 per person/day, adapt existing task)
 * - disqualify only after a note «Sales-Portal: Nicht qualifiziert – <Grund>» (added automatically if the rule has none)
 * - another contact person (6.8): same person → update lead, other person → new lead (max. 2 per company),
 *   previous lead becomes «Zweitkontakt» (or «Kontakt nicht möglich» via the wrong-person rule)
 * - write order on push: Notiz → Felder → Status (adapter)
 */
import { addDays } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { multiOptionLabels, optionLabel, STATE, STATUS, type OptionSetName } from './i18n';
import { normalizePhone, toCrmPhone } from './phone';
import { PORTAL_NOTE_PREFIX } from './realContact';
import { addWorkdays, applyTaskRules, type TaskProposal } from './taskRules';
import { ZURICH_TZ, zurichDayDiff } from './time';
import type {
  ActivityOp,
  Actor,
  CallSession,
  CallStatusRule,
  ChangeSet,
  Conflict,
  CrmTask,
  CrmTaskType,
  FieldAction,
  FieldOp,
  Lead,
  LeadCreateOp,
  LeadRecord,
  NoteOp,
  OperationResult,
  ResultGroupKey,
  ResultGroupRule,
  ResultInput,
  RuleCondition,
  StateOp,
  TaskOp,
} from './types';

export interface BuildChangeSetInput {
  rule: ResultGroupRule;
  lead: Lead;
  input: ResultInput;
  actor: Actor;
  callSession: Pick<
    CallSession,
    'id' | 'dialedAt' | 'connectedAt' | 'endedAt' | 'durationSec' | 'noteDraft' | 'phoneE164' | 'phoneDisplay' | 'direction'
  > | null;
  /** Open tasks of the whole company (all leads with the same domain). */
  openCompanyTasks: CrmTask[];
  /** Open tasks of the task owner (for «max. 3 pro Person und Tag»). */
  ownerOpenTasks: CrmTask[];
  now: Date;
  timeZone?: string;
  /** Setting `tasks.maxPerPersonPerDay` (default 3). */
  maxTasksPerPersonPerDay?: number;
  /** Open leads of the same company including this one (INTENT 6.8: max. 2 leads per company). */
  companyOpenLeadCount?: number;
}

/** ChangeSet before it is stored (server adds id, status, timestamps). */
export type ChangeSetDraft = Omit<
  ChangeSet,
  'id' | 'status' | 'createdBy' | 'createdAt' | 'updatedAt' | 'conflicts' | 'results' | 'pushedAt' | 'pushedBy' | 'error'
>;

export interface ResultInputIssue {
  /** `booking`: «Termin gebucht» without an active booking (checked by the server, not by the engine). */
  field: keyof ResultInput | 'newPerson.lastname' | 'newPerson.email' | 'newPerson.phone' | 'booking';
  message: string;
}

/** Thrown by `buildChangeSet` when the wrap-up input is incomplete (German messages for the form). */
export class ResultInputError extends Error {
  constructor(public readonly issues: ResultInputIssue[]) {
    super(issues.map((i) => i.message).join(' · '));
    this.name = 'ResultInputError';
  }
}

export const MAX_LEADS_PER_COMPANY = 2;
const DEFAULT_TASK_HOUR = '09:00';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---------------------------------------------------------------------------------------------------------------------
// Labels and display values
// ---------------------------------------------------------------------------------------------------------------------

export const LEAD_FIELD_LABELS: Partial<Record<keyof LeadRecord, string>> = {
  kls_callstatus: 'Anrufstatus',
  kls_rating_category: 'Bewertung',
  statuscode: 'Statusgrund',
  statecode: 'Status',
  ownerid: 'Besitzer',
  telephone1: 'Telefon',
  mobilephone: 'Mobile',
  emailaddress1: 'E-Mail',
  firstname: 'Vorname',
  lastname: 'Nachname',
  jobtitle: 'Funktion',
  numberofemployees: 'Mitarbeitende',
  kls_lead_support: 'Lead-Support',
  subject: 'Thema',
  kls_interests: 'Interessen',
  decisionmaker: 'Entscheider',
  donotphone: 'Nicht anrufen',
  donotemail: 'Keine E-Mails',
  donotbulkemail: 'Keine Massen-Mails',
  kls_competitor: 'Mitbewerber',
  kls_salutation: 'Anrede',
};

const FIELD_OPTION_SET: Partial<Record<string, OptionSetName>> = {
  kls_callstatus: 'kls_callstatus',
  kls_rating_category: 'kls_rating_category',
  statuscode: 'statuscode',
  statecode: 'statecode',
  kls_lead_support: 'kls_lead_support',
  kls_interests: 'kls_interests',
  kls_salutation: 'kls_salutation',
  leadsourcecode: 'leadsourcecode',
};

/** Human-readable value for the preview (option labels, Ja/Nein, «leer»). Owner ids need names → pass `names`. */
export function displayFieldValue(field: string, value: unknown, names?: Record<string, string>): string | null {
  if (isEmptyValue(value)) return null;
  const set = FIELD_OPTION_SET[field];
  if (set && Array.isArray(value)) return multiOptionLabels(set, value as number[]).join(', ');
  if (set && typeof value === 'number') return optionLabel(set, value);
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
  if (typeof value === 'string' && names?.[value]) return names[value];
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

// ---------------------------------------------------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------------------------------------------------

export function isEmptyValue(v: unknown): boolean {
  return v == null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
}

/** Loose equality for CRM values: empty == empty, arrays as sets, numbers vs numeric strings, ISO dates by instant. */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  if (isEmptyValue(a) || isEmptyValue(b)) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    const sa = [...a].map(String).sort();
    const sb = [...b].map(String).sort();
    return sa.length === sb.length && sa.every((x, i) => x === sb[i]);
  }
  if (typeof a === 'string' && typeof b === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(a) && /^\d{4}-\d{2}-\d{2}T/.test(b)) {
    return Date.parse(a) === Date.parse(b);
  }
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return a === b;
}

function inputValue(input: ResultInput, key: keyof ResultInput): unknown {
  return input[key];
}

function fillTemplate(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template
    .replace(/\{(\w+)\}/g, (_m, key: string) => {
      const v = vars[key];
      return v == null ? '' : String(v);
    })
    .replace(/\s+\./g, '.')
    .replace(/\.\s*\./g, '.')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------------------------------------------------
// Conditions and call status
// ---------------------------------------------------------------------------------------------------------------------

export function evaluateCondition(condition: RuleCondition | undefined, lead: Lead, input: ResultInput): boolean {
  if (!condition) return true;
  switch (condition.kind) {
    case 'always':
      return true;
    case 'interest_gte':
      return input.interest != null && input.interest >= condition.value;
    case 'employees_lt': {
      const n = input.employees ?? lead.numberofemployees;
      return n != null && n < condition.value;
    }
    case 'employees_gte': {
      const n = input.employees ?? lead.numberofemployees;
      return n != null && n >= condition.value;
    }
    case 'input_true':
      return inputValue(input, condition.input) === true;
    case 'input_present':
      return !isEmptyValue(inputValue(input, condition.input));
    case 'input_absent':
      return isEmptyValue(inputValue(input, condition.input));
    default:
      return false;
  }
}

/** kls_callstatus for a callback date («heute», «morgen», «bis 7 Tage», «bis 31 Tage», «später»). */
export function callStatusForDate(rule: CallStatusRule, followUpAt: Date | null, now: Date, timeZone: string = ZURICH_TZ): number | null {
  if (rule.mode === 'none') return null;
  if (rule.mode === 'fixed') return rule.value ?? null;
  if (!followUpAt || Number.isNaN(followUpAt.getTime())) return null;
  const days = Math.max(0, tzDayDiff(now, followUpAt, timeZone));
  for (const step of rule.byDate ?? []) {
    if (step.maxDays == null || days <= step.maxDays) return step.value;
  }
  return null;
}

function tzDayDiff(from: Date, to: Date, timeZone: string): number {
  if (timeZone === ZURICH_TZ) return zurichDayDiff(from, to);
  const a = fromZonedTime(`${formatInTimeZone(from, timeZone, 'yyyy-MM-dd')}T00:00:00`, timeZone).getTime();
  const b = fromZonedTime(`${formatInTimeZone(to, timeZone, 'yyyy-MM-dd')}T00:00:00`, timeZone).getTime();
  return Math.round((b - a) / 86_400_000);
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------------

function ruleNeedsFollowUpDate(rule: ResultGroupRule): boolean {
  return rule.callStatus.mode === 'by_date' || rule.followUp.dueFrom === 'followUpAt' || (rule.inputs ?? []).includes('followUpAt');
}

/** Does this rule (with this input) disqualify the lead? */
export function willDisqualify(rule: ResultGroupRule, lead: Lead, input: ResultInput): boolean {
  return rule.fieldActions.some((a) => a.kind === 'disqualify' && evaluateCondition(a.condition, lead, input));
}

/** Input checks for the wrap-up form; empty array = ok. */
export function validateResultInput(
  rule: ResultGroupRule,
  lead: Lead,
  input: ResultInput,
  options: { now: Date; companyOpenLeadCount?: number } = { now: new Date() },
): ResultInputIssue[] {
  const issues: ResultInputIssue[] = [];
  if (ruleNeedsFollowUpDate(rule)) {
    if (!input.followUpAt) issues.push({ field: 'followUpAt', message: 'Bitte Datum und Uhrzeit wählen' });
    else {
      const t = Date.parse(input.followUpAt);
      if (Number.isNaN(t)) issues.push({ field: 'followUpAt', message: 'Datum ist ungültig' });
      else if (t < options.now.getTime() - 15 * 60_000) issues.push({ field: 'followUpAt', message: 'Datum liegt in der Vergangenheit' });
    }
  }
  if (input.interest != null && (input.interest < 0 || input.interest > 3 || !Number.isInteger(input.interest))) {
    issues.push({ field: 'interest', message: 'Interesse muss 0–3 sein' });
  }
  if (rule.key === 'too_small' && (input.employees == null || !Number.isFinite(input.employees) || input.employees < 1)) {
    issues.push({ field: 'employees', message: 'Bitte die genannte Zahl Mitarbeitende angeben' });
  }
  if (input.employees != null && (input.employees < 1 || input.employees > 1_000_000 || !Number.isInteger(input.employees))) {
    if (!issues.some((i) => i.field === 'employees')) issues.push({ field: 'employees', message: 'Zahl Mitarbeitende ist ungültig' });
  }
  if (!isEmptyValue(input.correctedPhone)) {
    const n = normalizePhone(input.correctedPhone ?? null);
    if (n.status !== 'ok') issues.push({ field: 'correctedPhone', message: n.issue ?? 'Nummer prüfen' });
  }
  if (willDisqualify(rule, lead, input) && (input.reason ?? '').trim().length < 3) {
    issues.push({ field: 'reason', message: 'Bitte den Grund aus dem Gespräch angeben (Beleg für die Disqualifizierung)' });
  }
  const p = input.newPerson;
  if (p) {
    if (!p.lastname?.trim()) issues.push({ field: 'newPerson.lastname', message: 'Bitte mindestens den Nachnamen erfassen' });
    if (p.email && !EMAIL_RE.test(p.email.trim())) issues.push({ field: 'newPerson.email', message: 'E-Mail-Adresse prüfen' });
    if (p.phone && normalizePhone(p.phone).status !== 'ok') issues.push({ field: 'newPerson.phone', message: 'Telefonnummer prüfen' });
    if (!p.samePerson && options.companyOpenLeadCount != null) {
      const closesOld = willDisqualify(rule, lead, input);
      const after = options.companyOpenLeadCount - (closesOld ? 1 : 0) + 1;
      if (after > MAX_LEADS_PER_COMPANY) {
        issues.push({
          field: 'newPerson',
          message: `Pro Firma höchstens ${MAX_LEADS_PER_COMPANY} offene Leads – bestehenden Lead aktualisieren oder zuerst einen anderen schliessen`,
        });
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------------------------------------

class Ids {
  private n = 0;
  next(prefix: string): string {
    this.n += 1;
    return `${prefix}-${this.n}`;
  }
}

function taskDue(now: Date, tz: string, opts: { days?: number; workdays?: number }): Date {
  if (opts.workdays != null) {
    const d = addWorkdays(now, opts.workdays, tz);
    return atLocalTime(d, DEFAULT_TASK_HOUR, tz, now);
  }
  const d = addDays(now, opts.days ?? 0);
  return atLocalTime(d, DEFAULT_TASK_HOUR, tz, now);
}

/** Same calendar day at hh:mm local; never before `notBefore`. */
function atLocalTime(date: Date, hhmm: string, tz: string, notBefore: Date): Date {
  const day = formatInTimeZone(date, tz, 'yyyy-MM-dd');
  const at = fromZonedTime(`${day}T${hhmm}:00`, tz);
  return at.getTime() < notBefore.getTime() ? notBefore : at;
}

interface TaskCandidate {
  subject: string;
  due: Date;
  taskType: CrmTaskType;
  fixedDate: boolean;
}

export function buildChangeSet(args: BuildChangeSetInput): ChangeSetDraft {
  const { rule, lead, input, actor, callSession, now } = args;
  const tz = args.timeZone ?? ZURICH_TZ;
  const ids = new Ids();

  const issues = validateResultInput(rule, lead, input, { now, companyOpenLeadCount: args.companyOpenLeadCount });
  if (issues.length) throw new ResultInputError(issues);

  const vars = {
    company: lead.companyname,
    caller: actor.displayName,
    reason: input.reason?.trim() || null,
    employees: input.employees ?? lead.numberofemployees,
  };

  const operations: FieldOp[] = [];
  const notes: NoteOp[] = [];
  const stateChanges: StateOp[] = [];
  const tasks: TaskOp[] = [];
  const leadCreates: LeadCreateOp[] = [];
  const baseSnapshot: Record<string, unknown> = {};
  const names: Record<string, string> = {};
  if (lead.ownerid && lead.ownerName) names[lead.ownerid] = lead.ownerName;
  if (actor.crmUserId) names[actor.crmUserId] = actor.displayName;

  const current = (field: string): unknown => (lead as unknown as Record<string, unknown>)[field] ?? null;

  /** Add / replace a lead field op (later ops on the same field win). */
  const setField = (field: keyof LeadRecord, newValue: unknown, mode: FieldOp['mode'] = 'set', label?: string) => {
    const oldValue = current(field);
    let value = newValue;
    if (mode === 'add_to_multiselect') {
      const old = Array.isArray(oldValue) ? (oldValue as unknown[]) : [];
      const add = Array.isArray(newValue) ? newValue : [newValue];
      const missing = add.filter((v) => !old.some((o) => valuesEqual(o, v)));
      if (!missing.length) return;
      value = [...old, ...missing];
    } else if (mode === 'set_if_empty') {
      if (!isEmptyValue(oldValue)) return;
    }
    if (valuesEqual(oldValue, value)) {
      // No change – drop an earlier op on the same field if there was one.
      const idx = operations.findIndex((o) => o.entity === 'lead' && o.field === field);
      if (idx >= 0) operations.splice(idx, 1);
      return;
    }
    const op: FieldOp = {
      id: ids.next('field'),
      entity: 'lead',
      entityId: lead.leadid,
      field,
      label: label ?? LEAD_FIELD_LABELS[field] ?? field,
      oldValue,
      newValue: value,
      mode,
      oldDisplay: displayFieldValue(field, oldValue, names),
      newDisplay: displayFieldValue(field, value, names),
    };
    const idx = operations.findIndex((o) => o.entity === 'lead' && o.field === field);
    if (idx >= 0) operations[idx] = op;
    else operations.push(op);
    baseSnapshot[snapshotKey('lead', lead.leadid, field)] = oldValue;
  };

  // 1. Phone call activity (always) ---------------------------------------------------------------------------------
  const inbound = callSession?.direction === 'inbound';
  const connected = callSession?.connectedAt ? new Date(callSession.connectedAt) : null;
  const start = connected ?? (callSession?.dialedAt ? new Date(callSession.dialedAt) : now);
  const end = callSession?.endedAt ? new Date(callSession.endedAt) : now;
  const durationSec = connected
    ? (callSession?.durationSec ?? Math.max(0, Math.round((end.getTime() - connected.getTime()) / 1000)))
    : rule.key === 'not_reached'
      ? 0
      : (callSession?.durationSec ?? null);
  const note = callSession?.noteDraft?.trim() || null;
  const phonecall: ActivityOp = {
    id: ids.next('activity'),
    action: 'create',
    type: 'phonecall',
    leadId: lead.leadid,
    subject: `${inbound ? 'Rückruf' : 'Anruf'} ${lead.companyname} – ${rule.label}`,
    text: note,
    direction: inbound ? 'incoming' : 'outgoing',
    start: start.toISOString(),
    end: end.toISOString(),
    durationSec,
    resultCode: rule.anrufergebnis,
    interest: input.interest ?? null,
    phoneNumber: callSession?.phoneDisplay ?? lead.primaryPhone?.display ?? null,
  };

  // 2. Call status + rating -----------------------------------------------------------------------------------------
  const followUpAt = input.followUpAt ? new Date(input.followUpAt) : null;
  const callStatus = callStatusForDate(rule.callStatus, followUpAt, now, tz);
  if (callStatus != null) setField('kls_callstatus', callStatus);
  if (rule.ratingCategory && evaluateCondition(rule.ratingCategory.condition, lead, input)) {
    setField('kls_rating_category', rule.ratingCategory.value);
  }

  // 3. Owner → caller when reached ----------------------------------------------------------------------------------
  if (rule.setsOwnerToCaller && actor.crmUserId) setField('ownerid', actor.crmUserId);

  // 4. Field actions --------------------------------------------------------------------------------------------------
  const taskCandidates: TaskCandidate[] = [];
  let disqualify: FieldAction | null = null;
  for (const action of rule.fieldActions) {
    if (!evaluateCondition(action.condition, lead, input)) continue;
    switch (action.kind) {
      case 'set':
      case 'add_to_multiselect':
      case 'set_if_empty': {
        if (!action.field) break;
        let value: unknown = action.valueFrom ? inputValue(input, action.valueFrom) : action.value;
        if (isEmptyValue(value)) break;
        let field = action.field;
        if (action.valueFrom === 'correctedPhone') {
          value = toCrmPhone(normalizePhone(String(value)));
          if (input.correctedPhoneField === 'mobilephone') field = 'mobilephone';
        }
        setField(field, value, action.kind, action.label);
        break;
      }
      case 'note': {
        const text = fillTemplate(action.text ?? `${PORTAL_NOTE_PREFIX} {reason}`, vars);
        notes.push({ id: ids.next('note'), leadId: lead.leadid, text: text.startsWith(PORTAL_NOTE_PREFIX) ? text : `${PORTAL_NOTE_PREFIX} ${text}` });
        break;
      }
      case 'disqualify':
        disqualify = action;
        break;
      case 'task':
      case 'research': {
        const subject = fillTemplate(action.taskSubject ?? (action.kind === 'research' ? 'Kontakt-Research {company}' : 'Nachfassen {company}'), vars);
        const due = action.dueFrom && inputValue(input, action.dueFrom)
          ? new Date(String(inputValue(input, action.dueFrom)))
          : taskDue(now, tz, { days: action.offsetDays, workdays: action.offsetWorkdays });
        taskCandidates.push({ subject, due, taskType: action.kind === 'research' ? 'research' : 'follow_up', fixedDate: false });
        break;
      }
    }
  }

  // 5. Other contact person (6.8) -------------------------------------------------------------------------------------
  const person = input.newPerson && rule.isRealContact ? input.newPerson : null;
  let markSecondContact = false;
  if (person) {
    const phone = person.phone ? toCrmPhone(normalizePhone(person.phone)) : null;
    if (person.samePerson) {
      if (person.firstname?.trim()) setField('firstname', person.firstname.trim());
      if (person.lastname?.trim()) setField('lastname', person.lastname.trim());
      if (person.jobtitle?.trim()) setField('jobtitle', person.jobtitle.trim());
      if (person.email?.trim()) setField('emailaddress1', person.email.trim().toLowerCase());
      if (phone) setField('telephone1', phone);
      if (person.salutation != null) setField('kls_salutation', person.salutation);
    } else {
      const fields: Partial<LeadRecord> = {
        companyname: lead.companyname,
        websiteurl: lead.websiteurl,
        numberofemployees: input.employees ?? lead.numberofemployees,
        kls_industry: lead.kls_industry,
        kls_custom_industry: lead.kls_custom_industry,
        kls_leadscore: lead.kls_leadscore,
        kls_ki_bewertung: lead.kls_ki_bewertung,
        address1_postalcode: lead.address1_postalcode,
        address1_city: lead.address1_city,
        address1_stateorprovince: lead.address1_stateorprovince,
        parentaccountid: lead.parentaccountid,
        leadsourcecode: lead.leadsourcecode,
        kls_lead_support: lead.kls_lead_support,
        subject: lead.subject,
        firstname: person.firstname?.trim() || null,
        lastname: person.lastname.trim(),
        jobtitle: person.jobtitle?.trim() || null,
        emailaddress1: person.email?.trim().toLowerCase() || null,
        telephone1: phone,
        ownerid: actor.crmUserId,
        statecode: STATE.OPEN,
        statuscode: STATUS.NEW,
        kls_callstatus: callStatus ?? null,
      };
      // Salutation only when given (90-%-Regel: never guessed by the portal).
      if (person.salutation != null) fields.kls_salutation = person.salutation;
      leadCreates.push({ id: ids.next('lead'), fromLeadId: lead.leadid, fields });
      // Previous lead: «Kontakt nicht möglich» via the wrong-person rule, otherwise «Zweitkontakt».
      if (!disqualify && lead.statecode === STATE.OPEN) markSecondContact = true;
    }
  }

  // 6. Status: Neu → Kontaktiert, Zweitkontakt, disqualify ------------------------------------------------------------
  if (disqualify && lead.statecode === STATE.OPEN) {
    if (!notes.length) {
      notes.push({
        id: ids.next('note'),
        leadId: lead.leadid,
        text: fillTemplate(`${PORTAL_NOTE_PREFIX} Nicht qualifiziert – ${rule.label}. {reason}`, vars),
      });
    }
    const statuscode = disqualify.statuscode ?? STATUS.NO_LONGER_INTERESTED;
    stateChanges.push({
      id: ids.next('state'),
      leadId: lead.leadid,
      statecode: STATE.DISQUALIFIED,
      statuscode,
      label: disqualify.label ?? `Disqualifiziert: ${optionLabel('statuscode', statuscode)}`,
    });
    baseSnapshot[snapshotKey('lead', lead.leadid, 'statecode')] = lead.statecode;
    baseSnapshot[snapshotKey('lead', lead.leadid, 'statuscode')] = lead.statuscode;
  } else if (markSecondContact) {
    setField('statuscode', STATUS.SECOND_CONTACT, 'set', 'Statusgrund (bisherige Person)');
  } else if (rule.setsContacted && lead.statecode === STATE.OPEN && lead.statuscode === STATUS.NEW) {
    setField('statuscode', STATUS.CONTACTED);
  }

  // 7. Follow-up task (REGEL_AUFGABEN) --------------------------------------------------------------------------------
  const fu = rule.followUp;
  if (fu.type === 'task' || fu.type === 'mail') {
    const fromInput = fu.dueFrom ? inputValue(input, fu.dueFrom) : null;
    const due = fromInput ? new Date(String(fromInput)) : taskDue(now, tz, { days: fu.offsetDays, workdays: fu.offsetWorkdays });
    taskCandidates.push({
      subject: fillTemplate(fu.taskSubject ?? 'Nachfassen {company}', vars),
      due,
      taskType: rule.key === 'callback' ? 'callback' : 'follow_up',
      fixedDate: rule.key === 'callback' && !!fromInput,
    });
  }
  const leadClosed = stateChanges.length > 0;
  const candidate = leadClosed ? null : taskCandidates[0];
  if (candidate && actor.crmUserId) {
    const proposal: TaskProposal = {
      leadId: lead.leadid,
      subject: candidate.subject,
      description: note ? `Aus dem Anruf: ${note.slice(0, 500)}` : null,
      dueAt: candidate.due.toISOString(),
      ownerId: actor.crmUserId,
      taskType: candidate.taskType,
      fixedDate: candidate.fixedDate,
    };
    const decision = applyTaskRules(proposal, {
      openCompanyTasks: args.openCompanyTasks,
      ownerOpenTasks: args.ownerOpenTasks,
      maxPerPersonPerDay: args.maxTasksPerPersonPerDay ?? 3,
      now,
      timeZone: tz,
    });
    if (decision.op) {
      tasks.push({ ...decision.op, id: ids.next('task') });
      if (decision.op.action === 'update' && decision.op.taskId) {
        const existing = args.openCompanyTasks.find((t) => t.id === decision.op!.taskId);
        baseSnapshot[snapshotKey('task', decision.op.taskId, 'scheduledend')] = existing?.dueAt ?? null;
        baseSnapshot[snapshotKey('task', decision.op.taskId, 'subject')] = existing?.subject ?? null;
      }
    }
  } else if (rule.isRealContact) {
    // Newest info wins: a reached contact without a new follow-up makes open tasks of this lead obsolete.
    for (const t of args.openCompanyTasks) {
      if (t.statecode !== 0 || t.leadId !== lead.leadid) continue;
      tasks.push({
        id: ids.next('task'),
        action: 'cancel',
        taskId: t.id,
        leadId: lead.leadid,
        subject: t.subject,
        dueAt: t.dueAt,
        ownerId: t.ownerId,
        taskType: t.taskType,
        ruleNote: 'neueste Info gewinnt – Aufgabe nicht mehr nötig',
      });
    }
  }

  return {
    leadId: lead.leadid,
    callSessionId: callSession?.id ?? null,
    kind: rule.key === 'not_reached' ? 'not_reached' : 'call_result',
    ruleKey: rule.key,
    ruleVersion: rule.version,
    operations,
    activities: [phonecall],
    tasks,
    notes,
    stateChanges,
    leadCreates,
    baseSnapshot,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Conflicts (INTENT 6.9)
// ---------------------------------------------------------------------------------------------------------------------

/** Compare the draft's baseSnapshot with current CRM values (keys from `snapshotKey`). */
export function detectConflicts(
  changeSet: Pick<ChangeSet, 'operations' | 'baseSnapshot'> & { stateChanges?: StateOp[] },
  crmNow: Record<string, unknown>,
): Conflict[] {
  const conflicts: Conflict[] = [];
  for (const op of changeSet.operations) {
    // «zu Mehrfachauswahl hinzufügen» merges with whatever is in the CRM at push time – never a conflict.
    if (op.mode === 'add_to_multiselect') continue;
    const key = snapshotKey(op.entity, op.entityId, op.field);
    if (!(key in crmNow)) continue;
    const now = crmNow[key];
    if (valuesEqual(now, op.newValue)) continue;
    if (op.mode === 'set_if_empty') {
      if (!isEmptyValue(now)) conflicts.push(conflictOf(op.id, op.field, op.label, changeSet.baseSnapshot[key] ?? null, now, op.newValue));
      continue;
    }
    const draft = key in changeSet.baseSnapshot ? changeSet.baseSnapshot[key] : op.oldValue;
    if (!valuesEqual(draft, now)) conflicts.push(conflictOf(op.id, op.field, op.label, draft, now, op.newValue));
  }
  for (const s of changeSet.stateChanges ?? []) {
    for (const field of ['statecode', 'statuscode'] as const) {
      const key = snapshotKey('lead', s.leadId, field);
      if (!(key in crmNow) || !(key in changeSet.baseSnapshot)) continue;
      const draft = changeSet.baseSnapshot[key];
      const now = crmNow[key];
      if (!valuesEqual(draft, now) && !valuesEqual(now, s[field])) {
        conflicts.push(conflictOf(s.id, field, field === 'statecode' ? 'Status' : 'Statusgrund', draft, now, s[field]));
        break;
      }
    }
  }
  return conflicts;
}

function conflictOf(opId: string, field: string, label: string, draftValue: unknown, crmNow: unknown, newValue: unknown): Conflict {
  return { opId, field, label, draftValue: draftValue ?? null, crmNow: crmNow ?? null, newValue, resolution: null };
}

/**
 * Apply the caller's per-field decisions: `keep_crm` drops the operation, `overwrite` keeps it.
 * Returns the change set to push, or the conflicts that still need a decision.
 */
export function resolveConflicts<T extends Pick<ChangeSet, 'operations' | 'stateChanges'>>(
  changeSet: T,
  conflicts: Conflict[],
  resolutions: Record<string, 'overwrite' | 'keep_crm' | null | undefined>,
): { ok: true; changeSet: T; conflicts: Conflict[] } | { ok: false; conflicts: Conflict[] } {
  const resolved = conflicts.map((c) => ({ ...c, resolution: resolutions[c.opId] ?? c.resolution ?? null }));
  if (resolved.some((c) => !c.resolution)) return { ok: false, conflicts: resolved };
  const drop = new Set(resolved.filter((c) => c.resolution === 'keep_crm').map((c) => c.opId));
  return {
    ok: true,
    conflicts: resolved,
    changeSet: {
      ...changeSet,
      operations: changeSet.operations.filter((o) => !drop.has(o.id)),
      stateChanges: changeSet.stateChanges.filter((s) => !drop.has(s.id)),
    },
  };
}

/** Key used in ChangeSet.baseSnapshot. */
export function snapshotKey(entity: string, entityId: string, field: string): string {
  return `${entity}:${entityId}:${field}`;
}

/** All `entity:id` → fields to re-read for the conflict check. */
export function fieldsToReread(changeSet: Pick<ChangeSet, 'operations' | 'stateChanges'>): { entity: FieldOp['entity']; id: string; fields: string[] }[] {
  const map = new Map<string, { entity: FieldOp['entity']; id: string; fields: Set<string> }>();
  const add = (entity: FieldOp['entity'], id: string, field: string) => {
    const k = `${entity}:${id}`;
    const e = map.get(k) ?? { entity, id, fields: new Set<string>() };
    e.fields.add(field);
    map.set(k, e);
  };
  for (const op of changeSet.operations) add(op.entity, op.entityId, op.field);
  for (const s of changeSet.stateChanges) {
    add('lead', s.leadId, 'statecode');
    add('lead', s.leadId, 'statuscode');
  }
  return [...map.values()].map((e) => ({ entity: e.entity, id: e.id, fields: [...e.fields] }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Revert («Rückgängig» / «Zurücksetzen» from the audit)
// ---------------------------------------------------------------------------------------------------------------------

export interface RevertPlan {
  draft: ChangeSetDraft;
  /** Fields that were changed again in the CRM since the push – not reverted (nothing is silently overwritten). */
  skipped: { field: string; label: string; crmNow: unknown }[];
}

/**
 * Build a change set that undoes a pushed one: fields back to their old value (only if still unchanged since the push),
 * created activities and tasks cancelled, adapted tasks back to their old date, state back to the snapshot,
 * created leads cancelled. Notes cannot be deleted – a «Sales-Portal:» note documents the reset instead.
 */
export function buildRevertDraft(
  pushed: Pick<ChangeSet, 'id' | 'leadId' | 'callSessionId' | 'operations' | 'activities' | 'tasks' | 'notes' | 'stateChanges' | 'leadCreates' | 'baseSnapshot' | 'results'>,
  crmNow: Record<string, unknown>,
  options: { reason?: string } = {},
): RevertPlan {
  const ids = new Ids();
  const okIds = new Set(pushed.results.filter((r) => r.ok).map((r) => r.opId));
  const createdId = (opId: string) => pushed.results.find((r) => r.opId === opId && r.ok)?.createdId ?? null;
  const skipped: RevertPlan['skipped'] = [];
  const operations: FieldOp[] = [];
  const baseSnapshot: Record<string, unknown> = {};

  for (const op of pushed.operations) {
    if (!okIds.has(op.id)) continue;
    const key = snapshotKey(op.entity, op.entityId, op.field);
    const now = key in crmNow ? crmNow[key] : op.newValue;
    let target: unknown = op.oldValue;
    if (op.mode === 'add_to_multiselect') {
      const added = (Array.isArray(op.newValue) ? op.newValue : []).filter(
        (v) => !(Array.isArray(op.oldValue) ? op.oldValue : []).some((o) => valuesEqual(o, v)),
      );
      target = (Array.isArray(now) ? now : []).filter((v) => !added.some((a) => valuesEqual(a, v)));
      if (valuesEqual(target, now)) continue;
    } else if (!valuesEqual(now, op.newValue)) {
      skipped.push({ field: op.field, label: op.label, crmNow: now });
      continue;
    }
    operations.push({
      ...op,
      id: ids.next('field'),
      oldValue: now,
      newValue: target,
      mode: 'set',
      oldDisplay: op.newDisplay ?? displayFieldValue(op.field, now),
      newDisplay: op.oldDisplay ?? displayFieldValue(op.field, target),
    });
    baseSnapshot[key] = now;
  }

  const activities: ActivityOp[] = [];
  for (const a of pushed.activities) {
    const id = a.action === 'create' ? createdId(a.id) : null;
    if (!id) continue;
    activities.push({ ...a, id: ids.next('activity'), action: 'update', activityId: id, statecode: 2, subject: `${a.subject} (zurückgesetzt)` });
  }

  const tasks: TaskOp[] = [];
  for (const t of pushed.tasks) {
    if (!okIds.has(t.id)) continue;
    if (t.action === 'create') {
      const id = createdId(t.id);
      if (id) tasks.push({ ...t, id: ids.next('task'), action: 'cancel', taskId: id, ruleNote: 'zurückgesetzt' });
    } else if (t.action === 'update' && t.taskId) {
      const oldDue = pushed.baseSnapshot[snapshotKey('task', t.taskId, 'scheduledend')];
      const oldSubject = pushed.baseSnapshot[snapshotKey('task', t.taskId, 'subject')];
      tasks.push({
        ...t,
        id: ids.next('task'),
        action: 'update',
        dueAt: typeof oldDue === 'string' ? oldDue : t.dueAt,
        subject: typeof oldSubject === 'string' ? oldSubject : t.subject,
        ruleNote: 'zurückgesetzt',
      });
    }
  }

  const stateChanges: StateOp[] = [];
  for (const s of pushed.stateChanges) {
    if (!okIds.has(s.id)) continue;
    const statecode = pushed.baseSnapshot[snapshotKey('lead', s.leadId, 'statecode')];
    const statuscode = pushed.baseSnapshot[snapshotKey('lead', s.leadId, 'statuscode')];
    if (typeof statecode !== 'number' || typeof statuscode !== 'number') continue;
    stateChanges.push({ id: ids.next('state'), leadId: s.leadId, statecode, statuscode, label: `Status zurück: ${optionLabel('statuscode', statuscode)}` });
    baseSnapshot[snapshotKey('lead', s.leadId, 'statecode')] = s.statecode;
    baseSnapshot[snapshotKey('lead', s.leadId, 'statuscode')] = s.statuscode;
  }
  for (const l of pushed.leadCreates) {
    const id = createdId(l.id);
    if (!id) continue;
    stateChanges.push({ id: ids.next('state'), leadId: id, statecode: STATE.DISQUALIFIED, statuscode: STATUS.CANCELED, label: 'Neu angelegter Lead: abgebrochen' });
  }

  const notes: NoteOp[] = [];
  if (pushed.notes.some((n) => okIds.has(n.id)) || stateChanges.length) {
    notes.push({
      id: ids.next('note'),
      leadId: pushed.leadId,
      text: fillTemplate(`${PORTAL_NOTE_PREFIX} Änderungen zurückgesetzt. {reason}`, { reason: options.reason ?? null }),
    });
  }

  return {
    skipped,
    draft: {
      leadId: pushed.leadId,
      callSessionId: pushed.callSessionId ?? null,
      kind: 'manual',
      ruleKey: null,
      ruleVersion: null,
      operations,
      activities,
      tasks,
      notes,
      stateChanges,
      leadCreates: [],
      baseSnapshot,
    },
  };
}

/** Results of the operations that still need to run (retry after a partial failure skips what already worked). */
export function pendingPart<T extends Pick<ChangeSet, 'operations' | 'activities' | 'tasks' | 'notes' | 'stateChanges' | 'leadCreates'>>(
  changeSet: T,
  previous: OperationResult[],
): T {
  const done = new Set(previous.filter((r) => r.ok).map((r) => r.opId));
  return {
    ...changeSet,
    operations: changeSet.operations.filter((o) => !done.has(o.id)),
    activities: changeSet.activities.filter((o) => !done.has(o.id)),
    tasks: changeSet.tasks.filter((o) => !done.has(o.id)),
    notes: changeSet.notes.filter((o) => !done.has(o.id)),
    stateChanges: changeSet.stateChanges.filter((o) => !done.has(o.id)),
    leadCreates: changeSet.leadCreates.filter((o) => !done.has(o.id)),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Wrap-up panel helpers (shortcuts, «the group comes with its action»)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Keys taken while the result panel is visible (connected / wrap-up): «E» (Aufgelegt / Ergebnis) and the global keys.
 * The call-list keys (J/K/O) and the dial keys (A/N/V/X) are not active then, so the result groups may use them.
 */
export const RESULT_SHORTCUT_RESERVED: readonly string[] = ['e', '?', '/', 'g'];

/** Keys for groups without one (older rule versions had none for these). */
export const RESULT_SHORTCUT_FALLBACK: Partial<Record<ResultGroupKey, string>> = {
  internal_group: 'i',
  too_small: 'z',
  do_not_contact: 'd',
  competitor: 'c',
  wrong_person: 'f',
  wrong_number: 'u',
};

/** Shortcut per group: the admin's key unless reserved or already taken, else a free fallback key (rule order wins). */
export function resultGroupShortcuts(rules: Pick<ResultGroupRule, 'key' | 'shortcut'>[]): Map<ResultGroupKey, string> {
  const out = new Map<ResultGroupKey, string>();
  const taken = new Set<string>(RESULT_SHORTCUT_RESERVED);
  for (const r of rules) {
    const k = r.shortcut?.trim().toLowerCase();
    if (k && k.length === 1 && !taken.has(k)) {
      out.set(r.key, k);
      taken.add(k);
    }
  }
  for (const r of rules) {
    const k = RESULT_SHORTCUT_FALLBACK[r.key];
    if (!out.has(r.key) && k && !taken.has(k)) {
      out.set(r.key, k);
      taken.add(k);
    }
  }
  return out;
}

/** What a result group needs before it can be approved (INTENT 5 / 6.5: the group comes with its action). */
export type FollowUpRequirement = 'booking' | 'proposals' | 'mail' | null;

export function followUpRequirement(rule: Pick<ResultGroupRule, 'key' | 'followUp'> | null): FollowUpRequirement {
  if (!rule) return null;
  if (rule.followUp.type === 'booking') return 'booking';
  if (rule.key === 'proposals_sent') return 'proposals';
  if (rule.followUp.type === 'mail') return 'mail';
  return null;
}

/**
 * Were the proposals / the use-case mail sent for this lead since the call started? Looks at the person's own change
 * sets (scheduling: kind `mail` + ruleKey `proposals_sent`; ai: kind `mail` without rule). Without a call start the
 * last 12 hours count.
 */
export function followUpMailSent(
  changeSets: Pick<ChangeSet, 'kind' | 'ruleKey' | 'createdAt' | 'status'>[],
  need: 'proposals' | 'mail',
  since: string | null,
  now: Date = new Date(),
): boolean {
  const from = (since ? Date.parse(since) : now.getTime() - 12 * 3_600_000) - 60_000;
  return changeSets.some(
    (c) =>
      c.kind === 'mail' &&
      c.status !== 'discarded' &&
      (need === 'proposals' ? c.ruleKey === 'proposals_sent' : c.ruleKey !== 'proposals_sent') &&
      Date.parse(c.createdAt) >= from,
  );
}
