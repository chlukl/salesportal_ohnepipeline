/**
 * Core domain types of the Sales-Portal (ARCHITECTURE.md §6).
 *
 * Conventions
 * - All timestamps travel as ISO-8601 strings (UTC, `2026-11-20T09:30:00.000Z`). Local display uses Europe/Zurich.
 * - CRM field names mirror Dataverse logical names (`companyname`, `kls_callstatus`, …) so the live adapter can map 1:1.
 * - Option-set values are plain numbers (Dataverse codes); labels live in `i18n.ts`.
 * - Additive changes only (new types/fields at the end of a section); never rename. Note changes in ARCHITECTURE «Änderungen».
 */

// ---------------------------------------------------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------------------------------------------------

export type IsoDateTime = string;
/** Calendar date without time, `YYYY-MM-DD` (Europe/Zurich). */
export type IsoDate = string;
export type Uuid = string;
/** Dataverse GUID or mock id. */
export type CrmId = string;

export const ROLES = ['coldcaller', 'sales', 'ai_specialist', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type SortDirection = 'asc' | 'desc';

/** Who performed an action. `system` = background job / worker. */
export interface Actor {
  kind: 'user' | 'system';
  userId: Uuid | null;
  displayName: string;
  /** CRM systemuser id of the acting user (owner / "Von" on activities). */
  crmUserId: CrmId | null;
  email: string | null;
}

/** Shape of every error response body of the API. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
    /** Validation issues (paths + messages only, never input values). */
    issues?: { path: string; message: string }[];
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Scoring, bands, classification
// ---------------------------------------------------------------------------------------------------------------------

/** A ≥ 70, B ≥ 50, C ≥ 30, else D; no score → `unrated` («unbewertet»). */
export type Grade = 'A' | 'B' | 'C' | 'D' | 'unrated';
export const GRADES: Grade[] = ['A', 'B', 'C', 'D', 'unrated'];

/** Employee bands (INTENT 6.1). `1-4` is kept separately because «unter 5 MA kein Termin». */
export type EmployeeBand = '1-4' | '5-9' | '10-19' | '20-49' | '50-249' | '250-999' | '1000+' | 'unknown';

/** Organisation type (legal form / KI field `organisation`). */
export type OrgType = 'private' | 'public' | 'association' | 'unknown';

/** Role of the contact person derived from `jobtitle`. */
export type ContactRole = 'management' | 'it' | 'finance_operations' | 'sales_marketing' | 'production' | 'other' | 'unknown';

// ---------------------------------------------------------------------------------------------------------------------
// Phone numbers (INTENT 6.19) – implemented in phone.ts
// ---------------------------------------------------------------------------------------------------------------------

export type PhoneStatus = 'ok' | 'empty' | 'invalid' | 'multiple' | 'text';
export type PhoneType = 'fixed' | 'mobile' | 'toll_free' | 'other';
export type PhoneField = 'telephone1' | 'mobilephone' | 'telephone2' | 'telephone3';

export interface NormalizedPhone {
  /** Original value as stored in the CRM. */
  raw: string | null;
  status: PhoneStatus;
  /** Compact international format without spaces, `+41611234567`. Used for comparing and dialing. */
  e164: string | null;
  /** Readable international format, `+41 61 123 45 67`. Used for display and when writing to the CRM. */
  display: string | null;
  /** Extension («Durchwahl»), separated from the main number. */
  extension: string | null;
  /** ISO country of the number (CH, DE, FR …). */
  country: string | null;
  type: PhoneType | null;
  /** German hint for the UI when status ≠ ok, e.g. «Nummer prüfen: mehrere Nummern im Feld». */
  issue: string | null;
  /** status `multiple`: every valid number found in the field (E.164), so callback search still finds the lead. */
  candidates: string[];
}

export interface LeadPhone extends NormalizedPhone {
  field: PhoneField;
}

// ---------------------------------------------------------------------------------------------------------------------
// Campaign (INTENT 5, 6.17)
// ---------------------------------------------------------------------------------------------------------------------

export type CampaignReactionKind = 'opened' | 'clicked' | 'replied' | 'replied_positive' | 'replied_negative' | 'bounced' | 'unsubscribed';

export interface CampaignReaction {
  kind: CampaignReactionKind;
  at: IsoDateTime;
}

export interface CampaignMail {
  id: CrmId;
  leadId: CrmId;
  campaignName: string;
  /** Step within the sequence (1-based). */
  step: number;
  senderName: string;
  senderEmail: string | null;
  subject: string;
  sentAt: IsoDateTime;
  /** Use-case ids pushed in this mail (see `USE_CASES` in i18n.ts). */
  useCaseIds: string[];
  reactions: CampaignReaction[];
}

export interface CampaignStatus {
  inCampaign: boolean;
  campaignName: string | null;
  /** Latest activity that counts for the lock (sent mail, click, reply, call, note with text, appointment – not opens). */
  lastActivityAt: IsoDateTime | null;
  /** lastActivityAt + 3 months. */
  lockedUntil: IsoDateTime | null;
  /** true → hidden from the call list. */
  locked: boolean;
  /** Former campaign lead that is now callable → badge «aus Kampagne». */
  fromCampaign: boolean;
  /** Lead answered positively → appears as Pendenz «Antwort aus Kampagne» despite the lock (open question 7). */
  positiveReply: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Real contact (INTENT 5) – implemented in realContact.ts
// ---------------------------------------------------------------------------------------------------------------------

export type RealContactKind = 'call' | 'note' | 'email' | 'appointment';

export interface RealContact {
  kind: RealContactKind;
  at: IsoDateTime;
  activityId: CrmId;
  byName: string | null;
  /** kls_anrufergebnis for calls. */
  resultCode: number | null;
  summary: string | null;
}

/** Reasons why a lead is not in the call list (INTENT 5 «Gesperrt / ausgeblendet»). */
export type CallListExclusion =
  | 'campaign_locked'
  | 'divendo'
  | 'second_contact'
  | 'closed'
  | 'do_not_contact'
  | 'same_domain_in_progress'
  | 'existing_account';

// ---------------------------------------------------------------------------------------------------------------------
// Lead
// ---------------------------------------------------------------------------------------------------------------------

/** Lead as stored in Dataverse (logical field names). */
export interface LeadRecord {
  leadid: CrmId;
  companyname: string;
  firstname: string | null;
  lastname: string | null;
  fullname: string | null;
  jobtitle: string | null;
  emailaddress1: string | null;
  telephone1: string | null;
  mobilephone: string | null;
  websiteurl: string | null;
  numberofemployees: number | null;
  /** Branche (option set label in Prod, here: text). */
  kls_industry: string | null;
  /** Eigene Kategorie. */
  kls_custom_industry: string | null;
  kls_leadscore: number | null;
  /** Multi-line text: Stand / Grade / Einstieg / Stichworte / Nächster Schritt … */
  kls_ki_bewertung: string | null;
  kls_callstatus: number | null;
  kls_rating_category: number | null;
  /** 0 open, 1 qualified, 2 disqualified. */
  statecode: number;
  statuscode: number;
  ownerid: CrmId | null;
  ownerName: string | null;
  subject: string | null;
  leadsourcecode: number | null;
  kls_lead_support: number | null;
  kls_interests: number[];
  decisionmaker: boolean | null;
  donotphone: boolean;
  donotemail: boolean;
  donotbulkemail: boolean;
  kls_competitor: boolean | null;
  kls_salutation: number | null;
  address1_postalcode: string | null;
  address1_city: string | null;
  address1_stateorprovince: string | null;
  createdon: IsoDateTime;
  modifiedon: IsoDateTime;
  /** Account the lead belongs to (if any). */
  parentaccountid: CrmId | null;
}

/** Lead with values computed by the portal. */
export interface Lead extends LeadRecord {
  grade: Grade;
  employeeBand: EmployeeBand;
  orgType: OrgType;
  contactRole: ContactRole;
  /** Normalized phones (telephone1, mobilephone, …). */
  phones: LeadPhone[];
  /** Best number to dial (first `ok` phone, mobile only if no fixed line), or null → «Nummer prüfen». */
  primaryPhone: LeadPhone | null;
  /** Domain derived from websiteurl / email, used to find other persons of the company. */
  domain: string | null;
  campaign: CampaignStatus;
  lastRealContact: RealContact | null;
  /** Parsed first lines of kls_ki_bewertung. */
  assessment: LeadAssessment | null;
  /** Reasons the lead is hidden from the call list ([] = visible). */
  exclusions: CallListExclusion[];
  /** Earliest open task / callback due date for this lead (for «Fälligkeit»). */
  nextDueAt: IsoDateTime | null;
  /** Next attempt after «Nicht erreicht» (never in the same half-day, INTENT 6.1 Fälligkeit); null = no pending retry. */
  nextAttemptAt?: IsoDateTime | null;
}

/** Parsed `kls_ki_bewertung`. */
export interface LeadAssessment {
  stand: string | null;
  grade: string | null;
  einstieg: string | null;
  stichworte: string[];
  naechsterSchritt: string | null;
  organisation: string | null;
  /** Remaining lines (details, collapsed in the UI). */
  details: string[];
}

export type LeadSortKey =
  | 'score'
  | 'companyname'
  | 'numberofemployees'
  | 'lastRealContact'
  | 'nextDueAt'
  | 'modifiedon'
  | 'city'
  | 'due_then_score';

export type DueFilter = 'overdue' | 'today' | 'this_week' | 'any_open' | 'none';

export interface LeadQuery {
  search?: string;
  grades?: Grade[];
  scoreMin?: number;
  scoreMax?: number;
  employeeBands?: EmployeeBand[];
  industries?: string[];
  excludeIndustries?: string[];
  customIndustries?: string[];
  orgTypes?: OrgType[];
  cantons?: string[];
  /** PLZ prefixes, e.g. ['40', '41'] for the Basel region. */
  plzPrefixes?: string[];
  callStatuses?: number[];
  ratingCategories?: number[];
  statusCodes?: number[];
  /** Only leads whose last real contact is older than N days (or never). */
  noContactSinceDays?: number;
  subjects?: string[];
  leadSources?: number[];
  leadSupport?: number[];
  /** `exclude_locked` (default) hides locked campaign leads; `only_from_campaign` shows unlocked former campaign leads. */
  campaign?: 'exclude_locked' | 'only_from_campaign' | 'only_locked' | 'all';
  contactRoles?: ContactRole[];
  /** Only leads with at least one valid phone number (default true for the call list). */
  requirePhone?: boolean;
  ownerIds?: CrmId[];
  due?: DueFilter;
  decisionMaker?: boolean;
  /** Admin only: include leads that are hidden from the call list (exclusions). */
  includeHidden?: boolean;
  sort?: LeadSortKey;
  direction?: SortDirection;
  page?: number;
  pageSize?: number;
  /** Hide leads whose next attempt after «Nicht erreicht» is still in the future (same half-day). */
  hideRetryPending?: boolean;
  /** Skip these leads (e.g. already worked in this session – «nächster Lead»). */
  excludeLeadIds?: CrmId[];
  /** Only leads of these automated campaigns. */
  campaignNames?: string[];
  /** Only leads with an e-mail address. */
  requireEmail?: boolean;
}

/** Person of the same company (lead or contact), INTENT 6.2 left column. */
export interface CompanyPerson {
  source: 'lead' | 'contact';
  id: CrmId;
  fullName: string;
  jobtitle: string | null;
  contactRole: ContactRole;
  email: string | null;
  phones: LeadPhone[];
  /** true for the lead currently opened. */
  isCurrent: boolean;
  statecode: number | null;
  statuscode: number | null;
  decisionmaker: boolean | null;
  lastRealContact: RealContact | null;
}

export interface Account {
  accountid: CrmId;
  name: string;
  websiteurl: string | null;
  domain: string | null;
  telephone1: string | null;
  address1_city: string | null;
  address1_postalcode: string | null;
  address1_stateorprovince: string | null;
  numberofemployees: number | null;
  industry: string | null;
  ownerid: CrmId | null;
  /** Existing customer («bestehende Firma im CRM»). */
  isCustomer: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Activities, timeline, tasks
// ---------------------------------------------------------------------------------------------------------------------

export type ActivityType = 'phonecall' | 'email' | 'appointment' | 'note' | 'task';
export type ActivityDirection = 'outgoing' | 'incoming';

export interface TimelineItem {
  id: CrmId;
  type: ActivityType;
  at: IsoDateTime;
  subject: string | null;
  /** Note text / call notes / mail body (plain text, may be long). */
  text: string | null;
  direction: ActivityDirection | null;
  ownerId: CrmId | null;
  ownerName: string | null;
  durationSec: number | null;
  /** kls_anrufergebnis (phone calls). */
  resultCode: number | null;
  /** kls_interesse 0–3 (phone calls). */
  interest: number | null;
  /** Counts as real contact (INTENT 5). */
  isRealContact: boolean;
  /** Note created by the portal («Sales-Portal: …»). */
  isPortalNote: boolean;
  isCampaign: boolean;
  campaign: Pick<CampaignMail, 'campaignName' | 'step' | 'useCaseIds' | 'reactions' | 'senderName'> | null;
  /** Appointment start/end. */
  scheduledStart: IsoDateTime | null;
  scheduledEnd: IsoDateTime | null;
  /** 0 open, 1 completed, 2 cancelled. */
  statecode: number;
}

export interface PhoneCall {
  id: CrmId;
  leadId: CrmId | null;
  leadName: string | null;
  companyName: string | null;
  direction: ActivityDirection;
  subject: string | null;
  text: string | null;
  phoneNumber: string | null;
  phoneE164: string | null;
  ownerId: CrmId | null;
  ownerName: string | null;
  start: IsoDateTime;
  end: IsoDateTime | null;
  durationSec: number | null;
  resultCode: number | null;
  interest: number | null;
  transcriptLink: string | null;
}

export interface PhoneCallFilter {
  ownerId?: CrmId;
  leadId?: CrmId;
  direction?: ActivityDirection;
  from?: IsoDateTime;
  to?: IsoDateTime;
  resultCodes?: number[];
  limit?: number;
}

export type CrmTaskType = 'follow_up' | 'callback' | 'research' | 'other';

export interface CrmTask {
  id: CrmId;
  leadId: CrmId | null;
  leadName: string | null;
  companyName: string | null;
  subject: string;
  description: string | null;
  dueAt: IsoDateTime | null;
  ownerId: CrmId | null;
  ownerName: string | null;
  /** 0 open, 1 completed, 2 cancelled. */
  statecode: number;
  taskType: CrmTaskType;
  createdon: IsoDateTime;
  completedon: IsoDateTime | null;
}

export interface TaskFilter {
  ownerId?: CrmId;
  ownerIds?: CrmId[];
  leadId?: CrmId;
  status?: 'open' | 'completed' | 'all';
  dueBefore?: IsoDateTime;
  dueAfter?: IsoDateTime;
}

export interface PhoneMatch {
  entity: 'lead' | 'contact' | 'account';
  id: CrmId;
  /** Lead to open in the workspace (for contacts/accounts: best matching lead of the company, if any). */
  leadId: CrmId | null;
  name: string;
  companyName: string | null;
  field: PhoneField;
  phone: NormalizedPhone;
  /** Last outgoing call to this number / lead (why Markus called). */
  lastCall: PhoneCall | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Result groups (INTENT 6.5) – engine in resultGroups.ts
// ---------------------------------------------------------------------------------------------------------------------

export const RESULT_GROUP_KEYS = [
  'not_reached',
  'callback',
  'waiting',
  'meeting_booked',
  'proposals_sent',
  'info_mail',
  'later',
  'no_need',
  'has_partner',
  'internal_group',
  'too_small',
  'do_not_contact',
  'competitor',
  'wrong_person',
  'wrong_number',
] as const;
export type ResultGroupKey = (typeof RESULT_GROUP_KEYS)[number];

/** Lead fields that rules may touch. */
export type LeadFieldName = keyof LeadRecord;

/** Values the caller enters in the wrap-up form (used by `valueFrom` and conditions). */
export interface ResultInput {
  /** Callback / «später» date-time. */
  followUpAt?: IsoDateTime | null;
  /** Interest 0–3 (from Markus or the AI suggestion). */
  interest?: number | null;
  /** Number of employees named in the call («zu klein»). */
  employees?: number | null;
  /** Corrected phone (wrong number). */
  correctedPhone?: string | null;
  correctedPhoneField?: PhoneField | null;
  /** Decision maker attends the booked meeting. */
  decisionMakerInMeeting?: boolean | null;
  /** Reason text for disqualification notes («Beleg aus dem Gespräch»). */
  reason?: string | null;
  /** New contact person (wrong person / other contact, INTENT 6.8). */
  newPerson?: NewPersonInput | null;
  /** Budget named → optional rating level for «Termin gebucht». */
  budgetMentioned?: boolean | null;
}

export interface NewPersonInput {
  salutation?: number | null;
  firstname: string;
  lastname: string;
  jobtitle?: string | null;
  email?: string | null;
  phone?: string | null;
  /** Same person with new address → update lead; else new lead of the same company. */
  samePerson: boolean;
}

export type RuleCondition =
  | { kind: 'always' }
  | { kind: 'interest_gte'; value: number }
  | { kind: 'employees_lt'; value: number }
  | { kind: 'employees_gte'; value: number }
  | { kind: 'input_true'; input: keyof ResultInput }
  | { kind: 'input_present'; input: keyof ResultInput }
  | { kind: 'input_absent'; input: keyof ResultInput };

export type FieldActionKind = 'set' | 'add_to_multiselect' | 'set_if_empty' | 'disqualify' | 'note' | 'task' | 'research';

export interface FieldAction {
  kind: FieldActionKind;
  /** Lead field for set / add_to_multiselect / set_if_empty. */
  field?: LeadFieldName;
  /** German label shown in the preview. */
  label?: string;
  /** Fixed value. */
  value?: string | number | boolean | null;
  /** Take the value from the wrap-up input instead of `value`. */
  valueFrom?: keyof ResultInput;
  condition?: RuleCondition;
  /** disqualify: statuscode (statecode is always 2). */
  statuscode?: number;
  /** note: text template; placeholders {reason}, {company}, {caller}. */
  text?: string;
  /** task: subject template and due offset. */
  taskSubject?: string;
  offsetDays?: number;
  offsetWorkdays?: number;
  /** task due date from input (e.g. followUpAt). */
  dueFrom?: keyof ResultInput;
}

export interface CallStatusByDateStep {
  /** Max. calendar days from today (0 = today); null = everything later. */
  maxDays: number | null;
  value: number;
}

export interface CallStatusRule {
  mode: 'fixed' | 'by_date' | 'none';
  value?: number;
  /** for `by_date`: evaluated top-down against ResultInput.followUpAt. */
  byDate?: CallStatusByDateStep[];
}

export interface ResultGroupRule {
  key: ResultGroupKey;
  label: string;
  description?: string;
  version: number;
  /** Phone-call field kls_anrufergebnis. */
  anrufergebnis: number;
  callStatus: CallStatusRule;
  ratingCategory?: { value: number; condition?: RuleCondition } | null;
  /** Lead state handling: keep, set contacted (Neu → Kontaktiert) or disqualify via fieldActions. */
  state?: 'keep' | 'contacted';
  fieldActions: FieldAction[];
  followUp: {
    type: 'task' | 'mail' | 'booking' | 'research' | 'none';
    offsetDays?: number;
    offsetWorkdays?: number;
    /** Task due date from input (callback date). */
    dueFrom?: keyof ResultInput;
    taskSubject?: string;
    hint?: string;
  };
  setsOwnerToCaller: boolean;
  setsContacted: boolean;
  /** Someone was reached (counts as real contact). */
  isRealContact: boolean;
  /** Inputs the wrap-up form must show for this group. */
  inputs?: (keyof ResultInput)[];
  /** Keyboard shortcut in the wrap-up panel. */
  shortcut?: string;
  sortOrder: number;
  active: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Change sets (INTENT 6.9)
// ---------------------------------------------------------------------------------------------------------------------

export type ChangeSetKind =
  | 'call_result'
  | 'not_reached'
  | 'analysis'
  | 'task'
  | 'booking'
  | 'contact_person'
  | 'phone_fix'
  | 'mail'
  | 'manual';

export type ChangeSetStatus = 'draft' | 'pending' | 'conflict' | 'pushed' | 'failed' | 'discarded';

export type FieldOpMode = 'set' | 'add_to_multiselect' | 'set_if_empty';

export interface FieldOp {
  id: string;
  entity: 'lead' | 'phonecall' | 'contact' | 'account' | 'task' | 'email' | 'appointment';
  entityId: CrmId;
  field: string;
  label: string;
  oldValue: unknown;
  newValue: unknown;
  mode: FieldOpMode;
  /** Human-readable old/new (option-set labels), for the preview. */
  oldDisplay?: string | null;
  newDisplay?: string | null;
}

export interface ActivityOp {
  id: string;
  action: 'create' | 'update';
  type: 'phonecall' | 'email' | 'appointment';
  /** Existing activity id for `update`. */
  activityId?: CrmId | null;
  leadId: CrmId;
  subject: string;
  text: string | null;
  direction: ActivityDirection;
  start?: IsoDateTime | null;
  end?: IsoDateTime | null;
  durationSec?: number | null;
  resultCode?: number | null;
  interest?: number | null;
  phoneNumber?: string | null;
  transcriptLink?: string | null;
  to?: string[];
  /** `update` only: 0 open, 1 completed, 2 cancelled (e.g. «Rückgängig» cancels a created phone call). */
  statecode?: number | null;
}

export interface TaskOp {
  id: string;
  action: 'create' | 'update' | 'complete' | 'cancel';
  taskId?: CrmId | null;
  leadId: CrmId;
  subject: string;
  description?: string | null;
  dueAt?: IsoDateTime | null;
  ownerId?: CrmId | null;
  taskType: CrmTaskType;
  /** Explanation from taskRules («bestehende Aufgabe angepasst», «max. 3 pro Tag – auf Folgetag verschoben»). */
  ruleNote?: string | null;
}

export interface NoteOp {
  id: string;
  leadId: CrmId;
  /** Always starts with «Sales-Portal:». */
  text: string;
}

/** Disqualify / state change, executed last (Notiz → Felder → Status). */
export interface StateOp {
  id: string;
  leadId: CrmId;
  statecode: number;
  statuscode: number;
  label: string;
}

/** New lead for the same company (INTENT 6.8). */
export interface LeadCreateOp {
  id: string;
  /** Lead the new one is derived from (company data copied). */
  fromLeadId: CrmId;
  fields: Partial<LeadRecord>;
}

export interface Conflict {
  opId: string;
  field: string;
  label: string;
  /** Value at draft time (baseSnapshot). */
  draftValue: unknown;
  /** Value in the CRM right now. */
  crmNow: unknown;
  /** Value the change set wants to write. */
  newValue: unknown;
  /** Caller decision; push only possible when every conflict is resolved. */
  resolution?: 'overwrite' | 'keep_crm' | null;
}

export interface OperationResult {
  opId: string;
  kind: 'note' | 'field' | 'activity' | 'task' | 'state' | 'lead_create';
  ok: boolean;
  error?: string | null;
  /** Created CRM id (activity, task, note, lead). */
  createdId?: CrmId | null;
}

export interface ApplyResult {
  ok: boolean;
  results: OperationResult[];
  /** Created phone call id, if any (for later analysis enrichment). */
  phonecallId?: CrmId | null;
}

export interface ChangeSet {
  id: Uuid;
  leadId: CrmId;
  callSessionId?: Uuid | null;
  kind: ChangeSetKind;
  ruleKey?: ResultGroupKey | null;
  ruleVersion: number | null;
  operations: FieldOp[];
  activities: ActivityOp[];
  tasks: TaskOp[];
  notes: NoteOp[];
  stateChanges: StateOp[];
  leadCreates: LeadCreateOp[];
  /** CRM values of every touched field at draft time (`entity:id:field` → value). */
  baseSnapshot: Record<string, unknown>;
  status: ChangeSetStatus;
  conflicts: Conflict[];
  results: OperationResult[];
  error?: string | null;
  createdBy: Uuid;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  pushedAt?: IsoDateTime | null;
  pushedBy?: Uuid | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Call sessions (INTENT 6.2, 6.3, 6.15)
// ---------------------------------------------------------------------------------------------------------------------

/** Client-side call phase shown in the header: bereit · wählt · im Gespräch · Nachbearbeitung. */
export type CallPhase = 'idle' | 'dialing' | 'connected' | 'wrapup';

export type CallSessionStatus = 'dialing' | 'connected' | 'ended' | 'not_reached' | 'completed' | 'abandoned';
export type CallDirection = 'outbound' | 'inbound';
/** History categories (6.15). */
export type CallCategory = 'outbound' | 'callback_answered' | 'callback_missed' | 'unknown_number';

export interface CallSession {
  id: Uuid;
  userId: Uuid;
  leadId: CrmId | null;
  leadName: string | null;
  companyName: string | null;
  phoneE164: string | null;
  phoneDisplay: string | null;
  direction: CallDirection;
  category: CallCategory;
  status: CallSessionStatus;
  /** «Erstkontakt», «Rückruf vereinbart», «aus Kampagne» … */
  reason: string | null;
  dialedAt: IsoDateTime | null;
  connectedAt: IsoDateTime | null;
  endedAt: IsoDateTime | null;
  durationSec: number | null;
  durationSource: 'clicks' | 'vera' | null;
  veraEnabled: boolean;
  transcriptRef: string | null;
  noteDraft: string | null;
  noteSavedAt: IsoDateTime | null;
  resultGroup: ResultGroupKey | null;
  changeSetId: Uuid | null;
  crmPhonecallId: CrmId | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

// ---------------------------------------------------------------------------------------------------------------------
// Scheduling / bookings (INTENT 6.6, 6.10, 6.11)
// ---------------------------------------------------------------------------------------------------------------------

export interface BusyInterval {
  start: IsoDateTime;
  end: IsoDateTime;
  status: 'busy' | 'tentative' | 'oof' | 'workingElsewhere' | 'free';
  subject?: string | null;
}

export interface MailboxSchedule {
  email: string;
  busy: BusyInterval[];
  error?: string | null;
}

export interface Slot {
  start: IsoDateTime;
  end: IsoDateTime;
  /** Internal attendees free for start-30min … end+30min. */
  attendees: string[];
}

export type DayHalf = 'morning' | 'afternoon' | 'any';

export interface ProposalRequest {
  /** First day of the selected month (YYYY-MM-01). */
  month: IsoDate;
  preference: DayHalf;
  /** Slots to exclude (replace «anderer»). */
  excludeStarts?: IsoDateTime[];
}

export interface Proposal {
  slot: Slot;
  /** 1 = days 1–10, 2 = 11–20, 3 = 21–end. */
  monthThird: 1 | 2 | 3;
  half: Exclude<DayHalf, 'any'>;
}

export interface BookingRules {
  /** Allowed start windows, local time `HH:mm`. */
  startWindows: { from: string; to: string }[];
  /** No meetings in this window. */
  blockedWindows: { from: string; to: string }[];
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  slotStepMinutes: number;
  /** Default internal attendees (emails / user ids resolved by the server). */
  defaultSalesEmail: string;
  specialistEmail: string;
  extraCallSalesEmail: string;
  subjectTemplate: string;
  outlookCategory: string;
  briefingCategory: string;
  /** Briefing mail N days before if preparation needed. */
  briefingMailDaysBefore: number;
  timezone: string;
}

export type BookingStatus = 'booked' | 'rescheduled' | 'cancelled' | 'held';
export type BookingOrigin = 'coldcall' | 'campaign' | 'other';
export type BriefingStatus = 'open' | 'read' | 'prepared';

export interface ExternalAttendee {
  email: string;
  name?: string | null;
  isMainContact: boolean;
  response?: 'none' | 'accepted' | 'tentative' | 'declined';
}

export interface Booking {
  id: Uuid;
  /** Termin-ID (extended property on the event, `kls_buchung`). */
  bookingRef: string;
  leadId: CrmId;
  leadName: string | null;
  companyName: string | null;
  callSessionId: Uuid | null;
  salesUserId: Uuid | null;
  specialistUserId: Uuid | null;
  extraCall: boolean;
  start: IsoDateTime;
  end: IsoDateTime;
  status: BookingStatus;
  origin: BookingOrigin;
  eventId: string | null;
  iCalUId: string | null;
  blockerEventIds: string[];
  briefingEventIds: string[];
  needsPreparation: boolean;
  preparationNote: string | null;
  briefingStatus: BriefingStatus;
  externalAttendees: ExternalAttendee[];
  subject: string;
  createdBy: Uuid;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface CalendarAttendee {
  email: string;
  name?: string | null;
  type: 'required' | 'optional';
  response: 'none' | 'organizer' | 'accepted' | 'tentative' | 'declined';
}

export interface CalendarEvent {
  id: string;
  mailbox: string;
  subject: string;
  body: string | null;
  start: IsoDateTime;
  end: IsoDateTime;
  showAs: 'free' | 'tentative' | 'busy' | 'oof' | 'workingElsewhere';
  categories: string[];
  isCancelled: boolean;
  organizer: string | null;
  attendees: CalendarAttendee[];
  /** Extended properties, e.g. { KlsTerminId: '…' }. */
  extendedProperties: Record<string, string>;
  iCalUId: string | null;
  isOnlineMeeting: boolean;
  onlineJoinUrl: string | null;
  lastModified: IsoDateTime;
}

export interface CalendarEventInput {
  mailbox: string;
  subject: string;
  body?: string | null;
  start: IsoDateTime;
  end: IsoDateTime;
  showAs?: CalendarEvent['showAs'];
  categories?: string[];
  attendees?: Omit<CalendarAttendee, 'response'>[];
  extendedProperties?: Record<string, string>;
  isOnlineMeeting?: boolean;
}

export interface CalendarDelta {
  /** Changed or new events. */
  changed: CalendarEvent[];
  /** Ids of deleted events. */
  deleted: string[];
  nextToken: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------------------------------------------------

export interface MailDraft {
  to: string[];
  cc?: string[];
  subject: string;
  /** Plain-text body (HTML derived by the adapter). */
  body: string;
  relatedLeadId?: CrmId | null;
}

export interface SentMail {
  id: string;
  sentAt: IsoDateTime;
  /** Actual recipients (may be MAIL_TEST_RECIPIENT in mock/sandbox). */
  deliveredTo: string[];
  redirected: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// AI (INTENT 6.4, 6.7, 6.10) and transcripts
// ---------------------------------------------------------------------------------------------------------------------

export type AnalysisKind = 'call' | 'use_case_mail' | 'briefing';
export type AnalysisStatus = 'pending' | 'running' | 'ready' | 'approved' | 'rejected' | 'skipped' | 'failed';
export type Objection = 'partner' | 'internal_group' | 'too_small' | 'no_budget' | 'bad_timing' | 'no_interest';

export interface CallAnalysis {
  summary: string;
  interest: { level: 0 | 1 | 2 | 3; reason: string; quote: string | null };
  needs: { text: string; useCaseIds: string[] }[];
  decisionMaker: {
    reached: 'yes' | 'no' | 'forwarded';
    forwardedTo?: { name: string | null; jobtitle: string | null; email: string | null } | null;
  };
  objections: Objection[];
  suggestion: {
    resultGroup: ResultGroupKey | null;
    nextStep: string | null;
    nextStepDate: IsoDate | null;
    /** Field suggestions (alt → neu is computed by the server). */
    fields: { field: LeadFieldName; value: unknown; reason: string }[];
    preparationNeeded: boolean;
  };
}

export interface UseCaseMailDraft {
  subject: string;
  body: string;
  useCaseIds: string[];
  /** Sources for every hook («Aufhänger nur mit Quelle»). */
  sources: { claim: string; source: string }[];
}

export interface Briefing {
  company: string;
  profile: string;
  contact: string;
  campaignContext: string | null;
  history: string;
  useCases: { id: string; why: string }[];
  openingQuestions: string[];
  openPoints: string[];
  preparation: string[];
}

export interface Analysis {
  id: Uuid;
  kind: AnalysisKind;
  leadId: CrmId;
  callSessionId: Uuid | null;
  bookingId: Uuid | null;
  transcriptId: Uuid | null;
  status: AnalysisStatus;
  model: string | null;
  result: CallAnalysis | UseCaseMailDraft | Briefing | null;
  changeSetId: Uuid | null;
  error: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  reviewedBy: Uuid | null;
  reviewedAt: IsoDateTime | null;
}

export interface TranscriptSegment {
  speaker: 'caller' | 'callee' | 'unknown';
  startSec: number;
  text: string;
}

export interface Transcript {
  id: Uuid;
  callSessionId: Uuid | null;
  leadId: CrmId | null;
  source: 'vera' | 'mock';
  externalRef: string | null;
  startedAt: IsoDateTime | null;
  endedAt: IsoDateTime | null;
  durationSec: number | null;
  segments: TranscriptSegment[];
  fetchedAt: IsoDateTime;
  deleteAfter: IsoDateTime;
}

/** Context handed to the AI adapter (CRM text is data, never instructions). */
export interface AiCallContext {
  lead: Lead;
  persons: CompanyPerson[];
  timeline: TimelineItem[];
  campaignMails: CampaignMail[];
  note: string | null;
  transcript: Transcript | null;
  resultGroups: Pick<ResultGroupRule, 'key' | 'label'>[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Admin data: templates, objections, settings, audit, notifications, filters
// ---------------------------------------------------------------------------------------------------------------------

export type TemplateKind = 'subject' | 'invitation' | 'mail' | 'briefing' | 'proposals';

export interface Template {
  id: Uuid;
  key: string;
  label: string;
  kind: TemplateKind;
  subject: string | null;
  body: string;
  updatedBy: Uuid | null;
  updatedAt: IsoDateTime;
}

export interface ObjectionAnswer {
  id: Uuid;
  key: string;
  label: string;
  answer: string;
  sortOrder: number;
  active: boolean;
}

/** Typed settings (table `settings`, key → JSON value). */
export interface SettingsMap {
  'transcripts.retentionDays': number;
  'analysis.timeoutMinutes': number;
  'booking.rules': BookingRules;
  'calls.notReachedMailThreshold': { attempts: number; withinDays: number };
  'campaign.lockMonths': number;
  'tasks.maxPerPersonPerDay': number;
  'ai.monthlyBudgetUsd': number;
}
export type SettingKey = keyof SettingsMap;

export interface AuditEntry {
  id: number;
  at: IsoDateTime;
  actorUserId: Uuid | null;
  actorLabel: string;
  action: string;
  entity: string;
  entityId: string | null;
  field: string | null;
  oldValue: unknown;
  newValue: unknown;
  changeSetId: Uuid | null;
  meta: Record<string, unknown> | null;
}

export type NotificationKind =
  | 'booking_cancelled'
  | 'booking_rescheduled'
  | 'attendee_declined'
  | 'internal_declined'
  | 'push_failed'
  | 'mail_failed'
  | 'campaign_reply'
  | 'missed_callback'
  | 'system';

export interface Notification {
  id: Uuid;
  userId: Uuid;
  kind: NotificationKind;
  title: string;
  body: string | null;
  link: string | null;
  entity: string | null;
  entityId: string | null;
  severity: 'info' | 'warning' | 'error';
  readAt: IsoDateTime | null;
  doneAt: IsoDateTime | null;
  createdAt: IsoDateTime;
}

export type SavedFilterScope = 'leads' | 'pendenzen' | 'history';

export interface SavedFilter<TFilter = unknown> {
  id: Uuid;
  scope: SavedFilterScope;
  name: string;
  filter: TFilter;
  columns: string[] | null;
  isDefault: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

// ---------------------------------------------------------------------------------------------------------------------
// Me / header
// ---------------------------------------------------------------------------------------------------------------------

export interface PortalUser {
  id: Uuid;
  email: string;
  displayName: string;
  crmUserId: CrmId | null;
  roles: Role[];
  isActive: boolean;
}

export type EnvironmentLabel = 'Demo' | 'Sandbox' | 'Prod';

export interface MeResponse {
  user: { id: Uuid; email: string; displayName: string; crmUserId: CrmId | null };
  /** Real roles of the user. */
  roles: Role[];
  /** Roles used for authorization (= [viewAs] while «Ansicht als» is active). */
  effectiveRoles: Role[];
  viewAs: Role | null;
  isRealAdmin: boolean;
  csrfToken: string;
  environment: { label: EnvironmentLabel; authMode: 'dev' | 'entra'; integrations: 'mock' | 'live' | 'mixed' };
  features: Record<string, boolean>;
}

export interface HeaderCounters {
  /** Open Pendenzen (due tasks, unfinished calls, …). */
  pendenzen: number;
  /** Analyses waiting for approval. */
  analysen: number;
  /** Missed callbacks not yet handled. */
  missedCallbacks: number;
}
export type CounterKey = keyof HeaderCounters;

export interface AuthConfigResponse {
  authMode: 'dev' | 'entra';
  environmentLabel: EnvironmentLabel;
}

export interface DevUser {
  id: Uuid;
  displayName: string;
  email: string;
  roles: Role[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Pendenzen (INTENT 6.16) and history (6.15)
// ---------------------------------------------------------------------------------------------------------------------

export type PendenzKind =
  | 'task'
  | 'booking'
  | 'briefing'
  | 'cancellation'
  | 'unfinished_call'
  | 'analysis'
  | 'approval'
  | 'error'
  | 'campaign_reply';

export type PendenzDue = 'overdue' | 'today' | 'this_week' | 'later' | 'none';
export type PendenzOrigin = 'coldcall' | 'campaign' | 'other';

export interface PendenzItem {
  id: string;
  kind: PendenzKind;
  title: string;
  subtitle: string | null;
  dueAt: IsoDateTime | null;
  due: PendenzDue;
  ownerUserId: Uuid | null;
  ownerName: string | null;
  leadId: CrmId | null;
  companyName: string | null;
  origin: PendenzOrigin;
  status: 'open' | 'done';
  /** Reference to the underlying object (task id, booking id, change set id …). */
  ref: { type: string; id: string };
  link: string | null;
}

export interface HistoryEntry {
  id: string;
  at: IsoDateTime;
  category: CallCategory;
  direction: CallDirection;
  personName: string | null;
  companyName: string | null;
  leadId: CrmId | null;
  phoneDisplay: string | null;
  phoneE164: string | null;
  resultCode: number | null;
  notePreview: string | null;
  durationSec: number | null;
  /** Missed callback still open (highlighted until handled). */
  open: boolean;
  /** Last outgoing call to the same lead (context for callbacks). */
  lastOutbound: { at: IsoDateTime; resultCode: number | null } | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Dashboard (INTENT 6.12) – API contract of /api/dashboard (added by dashboard+admin implementer, additive)
// ---------------------------------------------------------------------------------------------------------------------

export type DashboardRange = 'week' | 'month' | 'quarter';

/** Rate with Wilson 95% interval; `rate`/`ci` are null below the minimum n («zu wenig Daten»). */
export interface RateValue {
  hits: number;
  n: number;
  rate: number | null;
  ci: { low: number; high: number } | null;
}

export interface DashboardBreakdownRow {
  key: string;
  label: string;
  /** Leads reached in the period. */
  n: number;
  appointment: RateValue;
  rejection: RateValue;
  tooFew: boolean;
}

export type DashboardDimension = 'industry' | 'customIndustry' | 'orgType' | 'employeeBand' | 'grade' | 'region' | 'source';

export interface DashboardBreakdown {
  dimension: DashboardDimension;
  label: string;
  rows: DashboardBreakdownRow[];
  /** Best/worst by appointment rate among rows with n ≥ minN (null when fewer than 2 such rows). */
  best: DashboardBreakdownRow | null;
  worst: DashboardBreakdownRow | null;
}

export interface DashboardReport {
  period: { range: DashboardRange; from: IsoDateTime; to: IsoDateTime; label: string; anchor: IsoDate; prevAnchor: IsoDate; nextAnchor: IsoDate | null };
  generatedAt: IsoDateTime;
  minN: number;
  activity: {
    calls: number;
    reached: number;
    /** Conversations ≥ 4 min. */
    conversations: number;
    days: { date: IsoDate; calls: number; reached: number; conversations: number }[];
    weeks: { week: IsoDate; label: string; calls: number; reached: number; conversations: number }[];
    /** weekday 1 = Monday … 7 = Sunday, hour 0–23 (Zurich). */
    heatmap: { weekday: number; hour: number; calls: number; reached: number }[];
  };
  results: {
    weeks: { week: IsoDate; label: string; counts: Partial<Record<ResultGroupKey, number>> }[];
    totals: { key: ResultGroupKey; label: string; count: number }[];
    leadsReached: number;
    appointment: RateValue;
    rejection: RateValue;
    reasons: { key: ResultGroupKey; label: string; count: number }[];
  };
  impact: DashboardBreakdown[];
  meetings: {
    total: number;
    bySales: { userId: Uuid | null; name: string; booked: number; extraCalls: number }[];
    extraCalls: number;
    /** Share of «Zusatzcall Lukas» among booked first meetings (null without bookings). */
    extraCallShare: number | null;
    cancelled: number;
    rescheduled: number;
    capacity: { week: IsoDate; label: string; sales: number; specialist: number; joint: number }[] | null;
    capacityNames: { sales: string; specialist: string };
    capacityError: string | null;
  };
  scoreCheck: {
    rows: DashboardBreakdownRow[];
    /** true: rates fall from A to D and the intervals of the best and worst grade do not overlap. null: too few data. */
    separates: boolean | null;
    monotonic: boolean | null;
  };
}

export interface WeeklyReportPreview {
  recipient: string | null;
  subject: string;
  body: string;
  lastSentWeek: IsoDate | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Admin (INTENT 6.14) – API contract of /api/admin (added by dashboard+admin implementer, additive)
// ---------------------------------------------------------------------------------------------------------------------

export interface ResultGroupRuleVersion {
  id: number;
  key: ResultGroupKey;
  version: number;
  label: string;
  isActive: boolean;
  createdBy: Uuid | null;
  createdByName: string | null;
  createdAt: IsoDateTime;
  definition: ResultGroupRule;
}

export interface SecretExpiry {
  name: string;
  label: string;
  /** Whether the secret is configured (never the value). */
  configured: boolean;
  expiresOn: IsoDate | null;
  status: 'ok' | 'warning' | 'expired' | 'unknown';
  daysLeft: number | null;
}

export interface AdminConnections {
  environment: EnvironmentLabel;
  authMode: 'dev' | 'entra';
  integrations: 'mock' | 'live' | 'mixed';
  adapters: { name: string; label: string; mode: 'mock' | 'live' }[];
  mailTestRecipient: boolean;
  secrets: SecretExpiry[];
}

export interface AdminSettings {
  transcriptRetentionDays: number;
  analysisTimeoutMinutes: number;
  aiMonthlyBudgetUsd: number;
  notReachedMailThreshold: { attempts: number; withinDays: number };
  campaignLockMonths: number;
  tasksMaxPerPersonPerDay: number;
  weeklyReportRecipient: string | null;
  /** Mailbox the weekly report is sent from; null = recipient mailbox. */
  weeklyReportSender: string | null;
}

export interface AdminErrorItem {
  id: string;
  source: 'change_set' | 'job';
  title: string;
  error: string | null;
  at: IsoDateTime;
  leadId: CrmId | null;
  actorName: string | null;
  attempts: number | null;
  retryable: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pendenzen + Anrufhistorie API (module pendenzen/history, INTENT 6.15, 6.16, 6.18)
// ---------------------------------------------------------------------------------------------------------------------

/** Inline actions offered on a Pendenz. `complete`/`reschedule` act on CRM tasks, `mark_done`/`snooze` on portal state. */
export type PendenzAction = 'complete' | 'reschedule' | 'mark_done' | 'snooze' | 'open_lead' | 'open_briefing';
export type PendenzTone = 'neutral' | 'info' | 'warning' | 'danger' | 'success';

export interface PendenzEntry extends PendenzItem {
  /** «gebucht», «verschoben», «Vorbereitung erledigt», «Konflikt» … */
  statusLabel: string | null;
  tone: PendenzTone;
  actions: PendenzAction[];
  taskType: CrmTaskType | null;
  snoozedUntil: IsoDateTime | null;
}

export interface PendenzFilter {
  kinds?: PendenzKind[];
  due?: PendenzDue[];
  /** Admin only (and «Ansicht als»): Pendenzen of another person. */
  userId?: Uuid;
  company?: string;
  origins?: PendenzOrigin[];
  status?: 'open' | 'done' | 'all';
}

export interface PendenzPerson {
  id: Uuid;
  displayName: string;
  roles: Role[];
}

export interface PendenzenResponse {
  items: PendenzEntry[];
  /** Per kind, after all filters except `kinds`. */
  counts: Record<PendenzKind, number>;
  /** Per Fälligkeit, after all filters except `due`. */
  dueCounts: Record<PendenzDue, number>;
  person: PendenzPerson;
  /** Person-specific ordering applied (coldcaller: unfinished calls, due callbacks and tasks first). */
  coldcallerFirst: boolean;
  /** Sources that could not be loaded (e.g. CRM not reachable) – shown as a calm hint, the rest still works. */
  warnings: string[];
}

export interface HistoryRow extends HistoryEntry {
  /** Portal call session (missed callbacks, unknown numbers) – target for «erledigt». */
  sessionId: Uuid | null;
  subject: string | null;
  /** Unknown number without lead → «einem Lead zuordnen». */
  assignable: boolean;
  handled: boolean;
}

export interface HistoryResponse {
  items: HistoryRow[];
  /** Per category, after day/result/search filters. */
  counts: Record<CallCategory, number>;
  openMissed: number;
  total: number;
}

export interface CallbackHit {
  key: string;
  source: 'lead' | 'contact' | 'account' | 'assignment' | 'name';
  leadId: CrmId | null;
  name: string;
  companyName: string | null;
  phoneDisplay: string | null;
  phoneE164: string | null;
  /** Last outgoing call → «warum hatte ich angerufen». */
  lastCall: { at: IsoDateTime; resultCode: number | null; subject: string | null; text: string | null } | null;
}

export interface CallbackSearchResponse {
  query: string;
  mode: 'phone' | 'name' | 'too_short';
  e164: string | null;
  display: string | null;
  hits: CallbackHit[];
  /** Valid number, no hit → «nicht im CRM». */
  unknown: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Use-Case-Katalog API (admin module, INTENT 3 «AI-Spezialist: Use Cases», 6.2, 6.7, 6.10, 6.17)
// ---------------------------------------------------------------------------------------------------------------------

/** One entry of the editable use-case catalog (stored in the portal DB, defaults from `USE_CASES` in i18n.ts). */
export interface UseCaseEntry {
  /** Stable key = Kampagnen-Kennung in Lemlist (e.g. `UC-DOC`). Never changes once created. */
  id: string;
  /** Title in everyday language. */
  label: string;
  /** Short name (mail subject, badges). */
  short: string;
  /** Short text: what the use case does for the customer. */
  description: string;
  /** Industry keywords where the use case typically fits. */
  industries: string[];
  /** Hidden entries stay resolvable for old campaign mails but are not proposed any more. */
  active: boolean;
  /** Part of the built-in default catalog. */
  builtIn: boolean;
  updatedAt: IsoDateTime | null;
  updatedByName: string | null;
}

export interface UseCasesResponse {
  items: UseCaseEntry[];
  /** Current (effective) roles may create/edit entries (AI-Spezialist, Admin). */
  canEdit: boolean;
}
