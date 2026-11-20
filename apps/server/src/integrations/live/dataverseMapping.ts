/**
 * Mapping between Dataverse rows and the shared domain types (ARCHITECTURE §6, INTENT 6.3/6.5/8).
 *
 * Field names are the Dataverse logical names used throughout the portal. Fields of the FixCRMSolution that are not
 * yet confirmed against the sandbox metadata are marked ASSUMED (see README «Live-Anbindung»).
 */
import {
  isPortalNote,
  normalizePhone,
  parseAssessment,
  type ActivityDirection,
  type ActivityOp,
  type Actor,
  type CrmTask,
  type CrmTaskType,
  type LeadRecord,
  type OrgType,
  type TaskOp,
  type TimelineItem,
} from '@sales-portal/shared';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { FORMATTED, LOOKUP_LOGICAL_NAME, type DvRow } from './dataverse';
import { assertGuid, isGuid } from './odata';

// ---------------------------------------------------------------------------------------------------------------------
// Entity sets
// ---------------------------------------------------------------------------------------------------------------------

export const ENTITY_SETS = {
  lead: 'leads',
  contact: 'contacts',
  account: 'accounts',
  phonecall: 'phonecalls',
  email: 'emails',
  appointment: 'appointments',
  task: 'tasks',
  note: 'annotations',
  systemuser: 'systemusers',
} as const;

export type DvEntity = keyof typeof ENTITY_SETS;

/** Activity entities are read-only while closed: updates must reopen + close again. */
export const ACTIVITY_ENTITIES: DvEntity[] = ['phonecall', 'email', 'appointment', 'task'];

/** Lookup attributes: domain field → navigation property + target entity set. */
const LOOKUPS: Record<string, { nav: string; target: string }> = {
  ownerid: { nav: 'ownerid', target: 'systemusers' },
  parentaccountid: { nav: 'parentaccountid', target: 'accounts' },
  parentcontactid: { nav: 'parentcontactid', target: 'contacts' },
  parentcustomerid: { nav: 'parentcustomerid_account', target: 'accounts' },
};

/** Multi-select option sets (Web API value: comma-separated string). */
const MULTI_SELECT = new Set(['kls_interests']);
/** Option sets the portal handles as labels (text) – read via formatted value, not writable by label. */
const LABEL_OPTION_SETS = new Set(['kls_industry', 'kls_custom_industry']);

export const LEAD_SELECT = [
  'leadid',
  'companyname',
  'firstname',
  'lastname',
  'fullname',
  'jobtitle',
  'emailaddress1',
  'telephone1',
  'mobilephone',
  'websiteurl',
  'numberofemployees',
  'kls_industry',
  'kls_custom_industry',
  'kls_leadscore',
  'kls_ki_bewertung',
  'kls_callstatus',
  'kls_rating_category',
  'statecode',
  'statuscode',
  '_ownerid_value',
  'subject',
  'leadsourcecode',
  'kls_lead_support',
  'kls_interests',
  'decisionmaker',
  'donotphone',
  'donotemail',
  'donotbulkemail',
  'kls_competitor',
  'kls_salutation',
  'address1_postalcode',
  'address1_city',
  'address1_stateorprovince',
  'createdon',
  'modifiedon',
  '_parentaccountid_value',
];

export const CONTACT_SELECT = ['contactid', 'firstname', 'lastname', 'jobtitle', 'emailaddress1', 'telephone1', 'mobilephone', '_parentcustomerid_value'];
export const ACCOUNT_SELECT = ['accountid', 'name', 'telephone1', 'telephone2', 'websiteurl', 'customertypecode'];

/** customertypecode «Kunde» (Dataverse default option 3). */
export const ACCOUNT_CUSTOMER_TYPE = 3;

export const PHONECALL_SELECT = [
  'activityid',
  'subject',
  'description',
  'directioncode',
  'phonenumber',
  'actualstart',
  'actualend',
  'actualdurationminutes',
  'scheduledstart',
  'createdon',
  'statecode',
  '_ownerid_value',
  '_regardingobjectid_value',
  'kls_anrufergebnis', // FixCRMSolution
  'kls_interesse', // FixCRMSolution
  'kls_transkript_link', // FixCRMSolution
];
/** Without `description` (rules only need type/result/duration). */
export const PHONECALL_SELECT_LIGHT = PHONECALL_SELECT.filter((f) => f !== 'description' && f !== 'kls_transkript_link');
export const EMAIL_SELECT_LIGHT = ['activityid', 'subject', 'directioncode', 'actualend', 'senton', 'createdon', 'statecode', '_ownerid_value', '_createdby_value', '_regardingobjectid_value', 'sender'];
export const EMAIL_SELECT = [...EMAIL_SELECT_LIGHT, 'description'];
export const APPOINTMENT_SELECT_LIGHT = ['activityid', 'subject', 'scheduledstart', 'scheduledend', 'createdon', 'statecode', '_ownerid_value', '_regardingobjectid_value'];
export const APPOINTMENT_SELECT = [...APPOINTMENT_SELECT_LIGHT, 'description'];
export const NOTE_SELECT = ['annotationid', 'subject', 'notetext', 'createdon', '_ownerid_value', '_objectid_value'];
export const TASK_SELECT = [
  'activityid',
  'subject',
  'description',
  'scheduledend',
  'statecode',
  'category',
  'createdon',
  'actualend',
  '_ownerid_value',
  '_regardingobjectid_value',
];

// ---------------------------------------------------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------------------------------------------------

export const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
export const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
export const formatted = (row: DvRow, attr: string): string | null => str(row[`${attr}@${FORMATTED}`]);
export const lookupId = (row: DvRow, field: string): string | null => {
  const v = row[`_${field}_value`];
  return isGuid(v) ? v.toLowerCase() : null;
};
export const lookupName = (row: DvRow, field: string): string | null => formatted(row, `_${field}_value`);
export const lookupType = (row: DvRow, field: string): string | null => str(row[`_${field}_value@${LOOKUP_LOGICAL_NAME}`]);
const iso = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/** Multi-select option set value (`"1,2"` or number[]) → number[]. */
export function parseMultiSelect(v: unknown): number[] {
  if (Array.isArray(v)) return v.map(Number).filter(Number.isFinite);
  if (typeof v === 'string') return v.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && String(n) !== '');
  if (typeof v === 'number') return [v];
  return [];
}

const FREEMAIL = new Set(['gmail.com', 'gmx.ch', 'gmx.net', 'gmx.de', 'bluewin.ch', 'hotmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'sunrise.ch', 'hispeed.ch', 'protonmail.com', 'proton.me']);

/** Company domain from website (preferred) or e-mail (not for freemail addresses). */
export function domainOf(websiteurl: string | null, email: string | null): string | null {
  if (websiteurl) {
    try {
      const host = new URL(/^https?:\/\//i.test(websiteurl) ? websiteurl : `https://${websiteurl.trim()}`).hostname.toLowerCase();
      const d = host.replace(/^www\./, '');
      if (d.includes('.')) return d;
    } catch {
      /* fall through */
    }
  }
  const at = email?.lastIndexOf('@') ?? -1;
  if (email && at > 0) {
    const d = email.slice(at + 1).trim().toLowerCase();
    if (d.includes('.') && !FREEMAIL.has(d)) return d;
  }
  return null;
}

/** Organisation type from the assessment line «Organisation: …» (scoring pipeline). */
export function orgTypeFrom(kiBewertung: string | null): OrgType {
  const org = parseAssessment(kiBewertung)?.organisation?.toLowerCase() ?? '';
  if (!org) return 'unknown';
  if (/öffentlich|oeffentlich|gemeinde|kanton|verwaltung|public|schule|spital/.test(org)) return 'public';
  if (/verein|verband|stiftung|genossenschaft|association/.test(org)) return 'association';
  if (/privat|ag|gmbh|private|einzelfirma/.test(org)) return 'private';
  return 'unknown';
}

/** Plain text from a (mail) HTML body – rendered as text in the UI, never as HTML. */
export function htmlToText(html: string | null): string | null {
  if (html == null) return null;
  if (!/[<&]/.test(html)) return html;
  const text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

/** Plain text → minimal HTML (escaped) for mail/email activity bodies. */
export function textToHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return `<div>${esc.replace(/\r?\n/g, '<br>')}</div>`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Rows → domain
// ---------------------------------------------------------------------------------------------------------------------

/** Dataverse lead row → LeadRecord (+ domain). */
export function mapLeadRecord(row: DvRow): LeadRecord & { domain: string | null } {
  const firstname = str(row.firstname);
  const lastname = str(row.lastname);
  const websiteurl = str(row.websiteurl);
  const emailaddress1 = str(row.emailaddress1);
  return {
    leadid: assertGuid(row.leadid, 'Lead-ID'),
    companyname: str(row.companyname) ?? '(ohne Firmenname)',
    firstname,
    lastname,
    fullname: str(row.fullname) ?? ([firstname, lastname].filter(Boolean).join(' ') || null),
    jobtitle: str(row.jobtitle),
    emailaddress1,
    telephone1: str(row.telephone1),
    mobilephone: str(row.mobilephone),
    websiteurl,
    numberofemployees: num(row.numberofemployees),
    kls_industry: formatted(row, 'kls_industry') ?? str(row.kls_industry),
    kls_custom_industry: formatted(row, 'kls_custom_industry') ?? str(row.kls_custom_industry),
    kls_leadscore: num(row.kls_leadscore),
    kls_ki_bewertung: str(row.kls_ki_bewertung),
    kls_callstatus: num(row.kls_callstatus),
    kls_rating_category: num(row.kls_rating_category),
    statecode: num(row.statecode) ?? 0,
    statuscode: num(row.statuscode) ?? 1,
    ownerid: lookupId(row, 'ownerid'),
    ownerName: lookupName(row, 'ownerid'),
    subject: str(row.subject),
    leadsourcecode: num(row.leadsourcecode),
    kls_lead_support: num(row.kls_lead_support),
    kls_interests: parseMultiSelect(row.kls_interests),
    decisionmaker: bool(row.decisionmaker),
    donotphone: bool(row.donotphone) ?? false,
    donotemail: bool(row.donotemail) ?? false,
    donotbulkemail: bool(row.donotbulkemail) ?? false,
    kls_competitor: bool(row.kls_competitor),
    kls_salutation: num(row.kls_salutation),
    address1_postalcode: str(row.address1_postalcode),
    address1_city: str(row.address1_city),
    address1_stateorprovince: str(row.address1_stateorprovince),
    createdon: iso(row.createdon) ?? new Date(0).toISOString(),
    modifiedon: iso(row.modifiedon) ?? new Date(0).toISOString(),
    parentaccountid: lookupId(row, 'parentaccountid'),
    domain: domainOf(websiteurl, emailaddress1),
  };
}

const direction = (v: unknown): ActivityDirection | null => (v === true ? 'outgoing' : v === false ? 'incoming' : null);

function baseItem(row: DvRow, type: TimelineItem['type']): TimelineItem {
  return {
    id: assertGuid(row.activityid ?? row.annotationid),
    type,
    at: iso(row.createdon) ?? new Date(0).toISOString(),
    subject: str(row.subject),
    text: null,
    direction: null,
    ownerId: lookupId(row, 'ownerid'),
    ownerName: lookupName(row, 'ownerid'),
    durationSec: null,
    resultCode: null,
    interest: null,
    isRealContact: false,
    isPortalNote: false,
    isCampaign: false,
    campaign: null,
    scheduledStart: null,
    scheduledEnd: null,
    statecode: num(row.statecode) ?? 1,
  };
}

/** Duration: exact from actualstart/actualend, else actualdurationminutes. */
export function phonecallDurationSec(row: DvRow): number | null {
  const s = iso(row.actualstart);
  const e = iso(row.actualend);
  if (s && e) {
    const d = Math.round((Date.parse(e) - Date.parse(s)) / 1000);
    if (d >= 0 && d < 86_400) return d;
  }
  const min = num(row.actualdurationminutes);
  return min != null ? min * 60 : null;
}

export function mapPhonecallItem(row: DvRow): TimelineItem {
  const item = baseItem(row, 'phonecall');
  item.at = iso(row.actualstart) ?? iso(row.createdon) ?? item.at;
  item.text = str(row.description);
  item.direction = direction(row.directioncode);
  item.durationSec = phonecallDurationSec(row);
  item.resultCode = num(row.kls_anrufergebnis);
  item.interest = num(row.kls_interesse);
  return item;
}

export function mapEmailItem(row: DvRow, campaignSenderIds: Set<string>): TimelineItem {
  const item = baseItem(row, 'email');
  item.at = iso(row.senton) ?? iso(row.actualend) ?? iso(row.createdon) ?? item.at;
  item.text = htmlToText(str(row.description));
  item.direction = direction(row.directioncode);
  const createdBy = lookupId(row, 'createdby');
  const owner = lookupId(row, 'ownerid');
  item.isCampaign = (!!createdBy && campaignSenderIds.has(createdBy)) || (!!owner && campaignSenderIds.has(owner));
  return item;
}

export function mapAppointmentItem(row: DvRow): TimelineItem {
  const item = baseItem(row, 'appointment');
  item.scheduledStart = iso(row.scheduledstart);
  item.scheduledEnd = iso(row.scheduledend);
  item.at = item.scheduledStart ?? item.at;
  item.text = str(row.description);
  return item;
}

export function mapNoteItem(row: DvRow): TimelineItem {
  const item = baseItem(row, 'note');
  item.text = str(row.notetext);
  item.isPortalNote = isPortalNote(item.text);
  item.statecode = 1;
  return item;
}

/** Task category (free text in Dataverse) ↔ portal task type. ASSUMED convention: category = portal type key. */
export function taskTypeOf(row: DvRow): CrmTaskType {
  const c = (str(row.category) ?? '').toLowerCase();
  if (c === 'callback' || c.includes('rückruf') || c.includes('rueckruf')) return 'callback';
  if (c === 'research' || c.includes('research')) return 'research';
  if (c === 'follow_up' || c.includes('nachfass')) return 'follow_up';
  const subject = (str(row.subject) ?? '').toLowerCase();
  if (subject.includes('rückruf')) return 'callback';
  if (subject.includes('research')) return 'research';
  if (subject.includes('nachfass')) return 'follow_up';
  return c ? 'other' : 'follow_up';
}

export function mapTaskItem(row: DvRow): TimelineItem {
  const item = baseItem(row, 'task');
  const due = iso(row.scheduledend);
  item.at = iso(row.actualend) ?? due ?? item.at;
  item.text = str(row.description);
  item.scheduledEnd = due;
  item.statecode = num(row.statecode) ?? 0;
  return item;
}

export function mapTask(row: DvRow, lead: { name: string | null; company: string | null } | null): CrmTask {
  const regardingIsLead = lookupType(row, 'regardingobjectid') === 'lead';
  return {
    id: assertGuid(row.activityid),
    leadId: regardingIsLead ? lookupId(row, 'regardingobjectid') : null,
    leadName: lead?.name ?? null,
    companyName: lead?.company ?? null,
    subject: str(row.subject) ?? '(ohne Betreff)',
    description: str(row.description),
    dueAt: iso(row.scheduledend),
    ownerId: lookupId(row, 'ownerid'),
    ownerName: lookupName(row, 'ownerid'),
    statecode: num(row.statecode) ?? 0,
    taskType: taskTypeOf(row),
    createdon: iso(row.createdon) ?? new Date(0).toISOString(),
    completedon: num(row.statecode) === 1 ? iso(row.actualend) : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Domain → payloads
// ---------------------------------------------------------------------------------------------------------------------

/** Attribute name to $select for a domain field (lookups use `_x_value`). */
export function selectNameOf(field: string): string {
  return LOOKUPS[field] ? `_${field}_value` : field;
}

/** Read a domain field from a row in the portal's representation (for conflict checks and audit). */
export function readField(row: DvRow, field: string): unknown {
  if (LOOKUPS[field]) return lookupId(row, field);
  if (MULTI_SELECT.has(field)) return parseMultiSelect(row[field]);
  if (LABEL_OPTION_SETS.has(field)) return formatted(row, field) ?? row[field] ?? null;
  const v = row[field];
  return v === undefined ? null : v;
}

/** Payload fragment for writing a domain field. Throws for values the CRM cannot take. */
export function fieldPayload(field: string, value: unknown): DvRow {
  const lookup = LOOKUPS[field];
  if (lookup) {
    if (value == null || value === '') return { [lookup.nav]: null };
    return { [`${lookup.nav}@odata.bind`]: `/${lookup.target}(${assertGuid(value)})` };
  }
  if (MULTI_SELECT.has(field)) {
    const list = Array.isArray(value) ? value.map(Number) : value == null ? [] : parseMultiSelect(value);
    return { [field]: list.length ? [...new Set(list)].join(',') : null };
  }
  if (LABEL_OPTION_SETS.has(field)) throw new Error(`field ${field} is an option set shown as label and cannot be written by label`);
  if (!/^[a-z_][a-z0-9_]*$/.test(field)) throw new Error('invalid field name');
  return { [field]: value === undefined ? null : value };
}

/** Values equal for conflict detection (null/'' equal, arrays as sets, dates by time, numeric strings). */
export function sameValue(a: unknown, b: unknown): boolean {
  const empty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
  if (empty(a) && empty(b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    const sa = [...(Array.isArray(a) ? a : parseMultiSelect(a))].map(String).sort();
    const sb = [...(Array.isArray(b) ? b : parseMultiSelect(b))].map(String).sort();
    return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
  }
  if (typeof a === 'string' && typeof b === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(a) && /^\d{4}-\d{2}-\d{2}T/.test(b)) return Date.parse(a) === Date.parse(b);
    if (isGuid(a) && isGuid(b)) return a.toLowerCase() === b.toLowerCase();
    return a === b;
  }
  if (typeof a === 'number' || typeof b === 'number') return num(a) != null && num(a) === num(b);
  return a === b;
}

const bind = (set: string, id: string) => `/${set}(${assertGuid(id)})`;

/** Regarding-lead navigation property per activity entity. */
const REGARDING_LEAD: Record<'phonecall' | 'email' | 'appointment' | 'task', string> = {
  phonecall: 'regardingobjectid_lead_phonecall@odata.bind',
  email: 'regardingobjectid_lead_email@odata.bind',
  appointment: 'regardingobjectid_lead_appointment@odata.bind',
  task: 'regardingobjectid_lead_task@odata.bind',
};

/** Note («Sales-Portal: …») on a lead. */
export function notePayload(leadId: string, text: string): DvRow {
  return {
    subject: 'Sales-Portal',
    notetext: text,
    'objectid_lead@odata.bind': bind('leads', leadId),
  };
}

/** Closing state per activity type and direction (statecode 1 = completed). */
export function closeStateOf(type: ActivityOp['type'] | 'task', dir: ActivityDirection | null): { statecode: number; statuscode: number } | null {
  switch (type) {
    case 'phonecall':
      return { statecode: 1, statuscode: dir === 'incoming' ? 4 : 2 }; // 2 = Made, 4 = Received
    case 'email':
      return { statecode: 1, statuscode: dir === 'incoming' ? 4 : 3 }; // 3 = Sent, 4 = Received
    case 'task':
      return { statecode: 1, statuscode: 5 }; // Completed
    default:
      return null; // appointments stay open/scheduled
  }
}

/** Create/update payload of a phonecall / email / appointment activity. */
export function activityPayload(op: ActivityOp, actor: Actor, mode: 'create' | 'update'): DvRow {
  const body: DvRow = { subject: op.subject.slice(0, 200) };
  if (op.text !== undefined) body.description = op.type === 'email' && op.text != null ? textToHtml(op.text) : op.text;
  if (op.type !== 'appointment') body.directioncode = op.direction === 'outgoing';
  if (op.type === 'phonecall') {
    if (op.start !== undefined) body.actualstart = op.start;
    if (op.end !== undefined) body.actualend = op.end;
    if (op.durationSec !== undefined) body.actualdurationminutes = op.durationSec == null ? null : Math.max(0, Math.round(op.durationSec / 60));
    if (op.phoneNumber !== undefined) body.phonenumber = op.phoneNumber;
    if (op.resultCode !== undefined) body.kls_anrufergebnis = op.resultCode;
    if (op.interest !== undefined) body.kls_interesse = op.interest;
    if (op.transcriptLink !== undefined) body.kls_transkript_link = op.transcriptLink;
  }
  if (op.type === 'appointment') {
    if (op.start !== undefined) body.scheduledstart = op.start;
    if (op.end !== undefined) body.scheduledend = op.end;
  }
  if (op.type === 'email' && op.start) body.actualstart = op.start;
  if (mode === 'create') {
    body[REGARDING_LEAD[op.type]] = bind('leads', op.leadId);
    const user = actor.crmUserId && isGuid(actor.crmUserId) ? actor.crmUserId : null;
    if (op.type === 'phonecall' || op.type === 'email') {
      const parties: DvRow[] = [];
      const userParty = (mask: number): DvRow | null => (user ? { participationtypemask: mask, 'partyid_systemuser@odata.bind': bind('systemusers', user) } : null);
      const leadParty = (mask: number): DvRow => ({ participationtypemask: mask, 'partyid_lead@odata.bind': bind('leads', op.leadId) });
      // participationtypemask: 1 = From, 2 = To
      if (op.direction === 'outgoing') {
        const from = userParty(1);
        if (from) parties.push(from);
        if (op.type === 'email' && op.to?.length) for (const address of op.to) parties.push({ participationtypemask: 2, addressused: address });
        else parties.push(leadParty(2));
      } else {
        parties.push(leadParty(1));
        const to = userParty(2);
        if (to) parties.push(to);
      }
      body[`${op.type}_activity_parties`] = parties;
    }
  }
  return body;
}

/** Task payload (create/update). ASSUMED: task type in `category`. */
export function taskPayload(op: TaskOp, mode: 'create' | 'update'): DvRow {
  const body: DvRow = { subject: op.subject.slice(0, 200), category: op.taskType };
  if (op.description !== undefined) body.description = op.description;
  if (op.dueAt !== undefined) body.scheduledend = op.dueAt;
  if (op.ownerId) body['ownerid@odata.bind'] = bind('systemusers', op.ownerId);
  if (mode === 'create') body[REGARDING_LEAD.task] = bind('leads', op.leadId);
  return body;
}

/** Fields of a LeadRecord that are computed / read-only and never written. */
const LEAD_READ_ONLY = new Set(['leadid', 'fullname', 'ownerName', 'createdon', 'modifiedon', 'statecode', 'statuscode']);

/** New lead from `Partial<LeadRecord>` (INTENT 6.8). */
export function leadCreatePayload(fields: Partial<LeadRecord>): DvRow {
  const body: DvRow = {};
  for (const [field, value] of Object.entries(fields)) {
    if (LEAD_READ_ONLY.has(field) || value === undefined) continue;
    if (LABEL_OPTION_SETS.has(field)) continue; // labels cannot be written; the lead keeps the CRM default
    Object.assign(body, fieldPayload(field, value));
  }
  if (!body.companyname) body.companyname = '(ohne Firmenname)';
  return body;
}

// ---------------------------------------------------------------------------------------------------------------------
// Phone search
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Spellings of one number as they appear in the CRM (+41 61 123 45 67, 061 123 45 67, 0041…, compact forms),
 * for an exact server-side `eq` filter. Combined with a digit-suffix `contains` and an in-memory check.
 */
export function phoneVariants(e164: string): string[] {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return [e164];
  const intl = parsed.formatInternational(); // +41 61 123 45 67
  const national = parsed.formatNational(); // 061 123 45 67
  const nsn = String(parsed.nationalNumber);
  const cc = String(parsed.countryCallingCode);
  const out = new Set<string>([
    e164,
    intl,
    national,
    national.replace(/\s/g, ''),
    `00${cc}${nsn}`,
    intl.replace(/^\+/, '00'),
    `+${cc} (0)${national.replace(/^0/, '')}`,
    `+${cc} ${nsn}`,
    intl.replace(/ /g, '-'),
    national.replace(/ /g, '-'),
    national.replace(/ /g, '.'),
  ]);
  return [...out].filter((v) => v.length <= 40);
}

/** Last 4 digits in the two usual groupings («4567» and «45 67») for the server-side contains filter. */
export function phoneSuffixes(digits: string): string[] {
  const last = digits.slice(-4);
  if (last.length < 4) return [];
  return [last, `${last.slice(0, 2)} ${last.slice(2)}`];
}

/** Does a raw CRM value denote the searched number (E.164) or end with the typed digits? */
export function phoneMatches(raw: string | null, e164: string | null, digits: string): boolean {
  if (!raw) return false;
  const n = normalizePhone(raw);
  const numbers = n.status === 'ok' && n.e164 ? [n.e164] : n.candidates;
  if (e164) return numbers.includes(e164);
  return numbers.some((x) => {
    const p = parsePhoneNumberFromString(x);
    return (p ? String(p.nationalNumber) : x.replace(/\D/g, '')).endsWith(digits);
  });
}
