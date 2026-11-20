/**
 * Drizzle schema – the same schema runs on Postgres 16 (prod) and PGlite (local).
 *
 * Shared file: changes only additive (new tables / nullable columns at the end), then `npm run db:generate`
 * and note it in ARCHITECTURE «Änderungen». Never rename or drop.
 *
 * Portal tables first, then the mock CRM (`mock_crm_*`) and mock calendar tables used by the mock adapters.
 */
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  ActivityOp,
  BookingRules,
  Briefing,
  CallAnalysis,
  CalendarAttendee,
  CampaignReaction,
  Conflict,
  ExternalAttendee,
  FieldOp,
  LeadCreateOp,
  NoteOp,
  OperationResult,
  ResultGroupRule,
  StateOp,
  TaskOp,
  TranscriptSegment,
  UseCaseMailDraft,
} from '@sales-portal/shared';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();

// =====================================================================================================================
// Users, roles, sessions
// =====================================================================================================================

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Lower-case. */
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    entraOid: text('entra_oid'),
    /** systemuserid in the CRM (owner of activities). */
    crmUserId: text('crm_user_id'),
    /** E.164 phone of the user (callback detection, 6.18). */
    phoneE164: text('phone_e164'),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: ts('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email), uniqueIndex('users_entra_oid_uq').on(t.entraOid)],
);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().$type<'coldcaller' | 'sales' | 'ai_specialist' | 'admin'>(),
    grantedBy: uuid('granted_by'),
    grantedAt: ts('granted_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.role] })],
);

export const sessions = pgTable(
  'sessions',
  {
    /** HMAC-SHA256(SESSION_SECRET, session id) – the raw id only lives in the cookie. */
    idHash: text('id_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    csrfToken: text('csrf_token').notNull(),
    viewAsRole: text('view_as_role').$type<'coldcaller' | 'sales' | 'ai_specialist' | 'admin'>(),
    authMethod: text('auth_method').notNull().$type<'dev' | 'entra'>(),
    /** AES-256-GCM encrypted JSON with access/refresh/id token (Entra), for later OBO calls. */
    tokensEnc: text('tokens_enc'),
    tokenExpiresAt: ts('token_expires_at'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    /** Absolute expiry (created + 7 days). */
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

export const savedFilters = pgTable(
  'saved_filters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull().$type<'leads' | 'pendenzen' | 'history'>(),
    name: text('name').notNull(),
    filter: jsonb('filter').notNull().$type<Record<string, unknown>>(),
    columns: jsonb('columns').$type<string[]>(),
    sort: jsonb('sort').$type<{ key: string; direction: 'asc' | 'desc' }>(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('saved_filters_user_scope_idx').on(t.userId, t.scope)],
);

// =====================================================================================================================
// Calls, change sets, audit
// =====================================================================================================================

export const callSessions = pgTable(
  'call_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    leadId: text('lead_id'),
    leadName: text('lead_name'),
    companyName: text('company_name'),
    phoneE164: text('phone_e164'),
    phoneDisplay: text('phone_display'),
    direction: text('direction').notNull().$type<'outbound' | 'inbound'>().default('outbound'),
    category: text('category')
      .notNull()
      .$type<'outbound' | 'callback_answered' | 'callback_missed' | 'unknown_number'>()
      .default('outbound'),
    status: text('status')
      .notNull()
      .$type<'dialing' | 'connected' | 'ended' | 'not_reached' | 'completed' | 'abandoned'>()
      .default('dialing'),
    reason: text('reason'),
    dialedAt: ts('dialed_at'),
    connectedAt: ts('connected_at'),
    endedAt: ts('ended_at'),
    durationSec: integer('duration_sec'),
    durationSource: text('duration_source').$type<'clicks' | 'vera'>(),
    veraEnabled: boolean('vera_enabled').notNull().default(true),
    transcriptRef: text('transcript_ref'),
    noteDraft: text('note_draft'),
    noteSavedAt: ts('note_saved_at'),
    resultGroup: text('result_group'),
    changeSetId: uuid('change_set_id'),
    crmPhonecallId: text('crm_phonecall_id'),
    /** Missed callback handled (6.15). */
    handledAt: ts('handled_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('call_sessions_user_idx').on(t.userId, t.createdAt),
    index('call_sessions_lead_idx').on(t.leadId),
    index('call_sessions_phone_idx').on(t.phoneE164),
  ],
);

export const changeSets = pgTable(
  'change_sets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: text('lead_id').notNull(),
    callSessionId: uuid('call_session_id'),
    kind: text('kind').notNull(),
    ruleKey: text('rule_key'),
    ruleVersion: integer('rule_version'),
    status: text('status')
      .notNull()
      .$type<'draft' | 'pending' | 'conflict' | 'pushed' | 'failed' | 'discarded'>()
      .default('draft'),
    operations: jsonb('operations').notNull().$type<FieldOp[]>().default([]),
    activities: jsonb('activities').notNull().$type<ActivityOp[]>().default([]),
    tasks: jsonb('tasks').notNull().$type<TaskOp[]>().default([]),
    notes: jsonb('notes').notNull().$type<NoteOp[]>().default([]),
    stateChanges: jsonb('state_changes').notNull().$type<StateOp[]>().default([]),
    leadCreates: jsonb('lead_creates').notNull().$type<LeadCreateOp[]>().default([]),
    baseSnapshot: jsonb('base_snapshot').notNull().$type<Record<string, unknown>>().default({}),
    conflicts: jsonb('conflicts').notNull().$type<Conflict[]>().default([]),
    results: jsonb('results').notNull().$type<OperationResult[]>().default([]),
    error: text('error'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    pushedAt: ts('pushed_at'),
    pushedBy: uuid('pushed_by'),
  },
  (t) => [
    index('change_sets_lead_idx').on(t.leadId),
    index('change_sets_status_idx').on(t.status, t.createdBy),
    index('change_sets_call_idx').on(t.callSessionId),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: ts('at').notNull().defaultNow(),
    actorUserId: uuid('actor_user_id'),
    /** Display name or `system`. */
    actorLabel: text('actor_label').notNull(),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    field: text('field'),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),
    changeSetId: uuid('change_set_id'),
    meta: jsonb('meta').$type<Record<string, unknown>>(),
  },
  (t) => [
    index('audit_at_idx').on(t.at),
    index('audit_entity_idx').on(t.entity, t.entityId),
    index('audit_change_set_idx').on(t.changeSetId),
  ],
);

// =====================================================================================================================
// Admin-maintained configuration
// =====================================================================================================================

export const resultGroupRules = pgTable(
  'result_group_rules',
  {
    id: serial('id').primaryKey(),
    key: text('key').notNull(),
    version: integer('version').notNull(),
    label: text('label').notNull(),
    definition: jsonb('definition').notNull().$type<ResultGroupRule>(),
    /** Only one active version per key. */
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('result_group_rules_key_version_uq').on(t.key, t.version)],
);

export const templates = pgTable(
  'templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    kind: text('kind').notNull().$type<'subject' | 'invitation' | 'mail' | 'briefing' | 'proposals'>(),
    subject: text('subject'),
    body: text('body').notNull(),
    updatedBy: uuid('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('templates_key_uq').on(t.key)],
);

export const objections = pgTable(
  'objections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    answer: text('answer').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    updatedBy: uuid('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('objections_key_uq').on(t.key)],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by'),
  updatedAt: updatedAt(),
});

/** Generic key/value state for background syncs (calendar delta tokens, last poll times …). */
export const syncState = pgTable('sync_state', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
});

// =====================================================================================================================
// AI, transcripts, bookings
// =====================================================================================================================

export const transcripts = pgTable(
  'transcripts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    callSessionId: uuid('call_session_id'),
    leadId: text('lead_id'),
    source: text('source').notNull().$type<'vera' | 'mock'>(),
    externalRef: text('external_ref'),
    language: text('language'),
    segments: jsonb('segments').notNull().$type<TranscriptSegment[]>().default([]),
    startedAt: ts('started_at'),
    endedAt: ts('ended_at'),
    durationSec: integer('duration_sec'),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
    /** Deleted by the retention job after this instant (default 30 days, admin setting). */
    deleteAfter: ts('delete_after').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('transcripts_delete_after_idx').on(t.deleteAfter), index('transcripts_call_idx').on(t.callSessionId)],
);

export const analyses = pgTable(
  'analyses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull().$type<'call' | 'use_case_mail' | 'briefing'>(),
    leadId: text('lead_id').notNull(),
    callSessionId: uuid('call_session_id'),
    bookingId: uuid('booking_id'),
    transcriptId: uuid('transcript_id'),
    /** Portal user the analysis waits for (Markus for call analyses). */
    ownerUserId: uuid('owner_user_id'),
    status: text('status')
      .notNull()
      .$type<'pending' | 'running' | 'ready' | 'approved' | 'rejected' | 'skipped' | 'failed'>()
      .default('pending'),
    model: text('model'),
    result: jsonb('result').$type<CallAnalysis | UseCaseMailDraft | Briefing>(),
    usage: jsonb('usage').$type<{ inputTokens: number; outputTokens: number; costUsd?: number }>(),
    changeSetId: uuid('change_set_id'),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: ts('reviewed_at'),
  },
  (t) => [index('analyses_status_owner_idx').on(t.status, t.ownerUserId), index('analyses_lead_idx').on(t.leadId)],
);

export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Termin-ID (extended property KlsTerminId on the event). */
    bookingRef: text('booking_ref').notNull(),
    leadId: text('lead_id').notNull(),
    leadName: text('lead_name'),
    companyName: text('company_name'),
    callSessionId: uuid('call_session_id'),
    salesUserId: uuid('sales_user_id'),
    specialistUserId: uuid('specialist_user_id'),
    extraCall: boolean('extra_call').notNull().default(false),
    startAt: ts('start_at').notNull(),
    endAt: ts('end_at').notNull(),
    status: text('status').notNull().$type<'booked' | 'rescheduled' | 'cancelled' | 'held'>().default('booked'),
    origin: text('origin').notNull().$type<'coldcall' | 'campaign' | 'other'>().default('coldcall'),
    eventId: text('event_id'),
    iCalUId: text('ical_uid'),
    blockerEventIds: jsonb('blocker_event_ids').notNull().$type<string[]>().default([]),
    briefingEventIds: jsonb('briefing_event_ids').notNull().$type<string[]>().default([]),
    needsPreparation: boolean('needs_preparation').notNull().default(false),
    preparationNote: text('preparation_note'),
    briefingStatus: text('briefing_status').notNull().$type<'open' | 'read' | 'prepared'>().default('open'),
    briefingMailSentAt: ts('briefing_mail_sent_at'),
    externalAttendees: jsonb('external_attendees').notNull().$type<ExternalAttendee[]>().default([]),
    subject: text('subject').notNull(),
    body: text('body'),
    crmBookingId: text('crm_booking_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('bookings_ref_uq').on(t.bookingRef),
    index('bookings_start_idx').on(t.startAt),
    index('bookings_lead_idx').on(t.leadId),
  ],
);

// =====================================================================================================================
// Jobs, notifications, mock outbox
// =====================================================================================================================

export const jobs = pgTable(
  'jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>().default({}),
    status: text('status').notNull().$type<'queued' | 'running' | 'done' | 'failed' | 'dead'>().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    runAt: ts('run_at').notNull().defaultNow(),
    lockedAt: ts('locked_at'),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    /** Prevents duplicates of queued/running jobs (e.g. one analysis per call). */
    dedupeKey: text('dedupe_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('jobs_claim_idx').on(t.status, t.runAt),
    uniqueIndex('jobs_dedupe_uq')
      .on(t.dedupeKey)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    entity: text('entity'),
    entityId: text('entity_id'),
    severity: text('severity').notNull().$type<'info' | 'warning' | 'error'>().default('info'),
    readAt: ts('read_at'),
    doneAt: ts('done_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.doneAt)],
);

export const mockOutbox = pgTable('mock_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  fromUserId: uuid('from_user_id'),
  fromEmail: text('from_email').notNull(),
  to: jsonb('to').notNull().$type<string[]>(),
  cc: jsonb('cc').notNull().$type<string[]>().default([]),
  /** Original recipients when redirected to MAIL_TEST_RECIPIENT. */
  originalTo: jsonb('original_to').$type<string[]>(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  relatedLeadId: text('related_lead_id'),
  sentAt: ts('sent_at').notNull().defaultNow(),
});

// =====================================================================================================================
// Mock CRM (Dataverse look-alike) – only used by integrations/crm/mock.ts
// =====================================================================================================================

export const mockCrmUsers = pgTable('mock_crm_users', {
  id: text('id').primaryKey(),
  fullname: text('fullname').notNull(),
  email: text('email').notNull(),
  title: text('title'),
});

export const mockCrmAccounts = pgTable('mock_crm_accounts', {
  accountid: text('accountid').primaryKey(),
  name: text('name').notNull(),
  websiteurl: text('websiteurl'),
  domain: text('domain'),
  telephone1: text('telephone1'),
  address1_city: text('address1_city'),
  address1_postalcode: text('address1_postalcode'),
  address1_stateorprovince: text('address1_stateorprovince'),
  numberofemployees: integer('numberofemployees'),
  industry: text('industry'),
  ownerid: text('ownerid'),
  isCustomer: boolean('is_customer').notNull().default(false),
  createdon: ts('createdon').notNull().defaultNow(),
  modifiedon: ts('modifiedon').notNull().defaultNow(),
});

export const mockCrmLeads = pgTable(
  'mock_crm_leads',
  {
    leadid: text('leadid').primaryKey(),
    companyname: text('companyname').notNull(),
    firstname: text('firstname'),
    lastname: text('lastname'),
    jobtitle: text('jobtitle'),
    emailaddress1: text('emailaddress1'),
    telephone1: text('telephone1'),
    mobilephone: text('mobilephone'),
    websiteurl: text('websiteurl'),
    /** Mock helper: company domain (persons of the same company). */
    domain: text('domain'),
    numberofemployees: integer('numberofemployees'),
    kls_industry: text('kls_industry'),
    kls_custom_industry: text('kls_custom_industry'),
    kls_leadscore: integer('kls_leadscore'),
    kls_ki_bewertung: text('kls_ki_bewertung'),
    kls_callstatus: integer('kls_callstatus'),
    kls_rating_category: integer('kls_rating_category'),
    statecode: integer('statecode').notNull().default(0),
    statuscode: integer('statuscode').notNull().default(1),
    ownerid: text('ownerid'),
    subject: text('subject'),
    leadsourcecode: integer('leadsourcecode'),
    kls_lead_support: integer('kls_lead_support'),
    kls_interests: jsonb('kls_interests').notNull().$type<number[]>().default([]),
    decisionmaker: boolean('decisionmaker'),
    donotphone: boolean('donotphone').notNull().default(false),
    donotemail: boolean('donotemail').notNull().default(false),
    donotbulkemail: boolean('donotbulkemail').notNull().default(false),
    kls_competitor: boolean('kls_competitor'),
    kls_salutation: integer('kls_salutation'),
    address1_postalcode: text('address1_postalcode'),
    address1_city: text('address1_city'),
    address1_stateorprovince: text('address1_stateorprovince'),
    parentaccountid: text('parentaccountid'),
    /** Mock helper: organisation type (live: parsed from kls_ki_bewertung / legal form). */
    orgType: text('org_type').$type<'private' | 'public' | 'association' | 'unknown'>(),
    /** Mock helper: automated campaign membership (live: Lemlist / lead support). */
    campaignName: text('campaign_name'),
    campaignJoinedAt: ts('campaign_joined_at'),
    createdon: ts('createdon').notNull().defaultNow(),
    modifiedon: ts('modifiedon').notNull().defaultNow(),
  },
  (t) => [index('mock_crm_leads_domain_idx').on(t.domain), index('mock_crm_leads_owner_idx').on(t.ownerid)],
);

export const mockCrmContacts = pgTable(
  'mock_crm_contacts',
  {
    contactid: text('contactid').primaryKey(),
    parentcustomerid: text('parentcustomerid'),
    firstname: text('firstname'),
    lastname: text('lastname'),
    jobtitle: text('jobtitle'),
    emailaddress1: text('emailaddress1'),
    telephone1: text('telephone1'),
    mobilephone: text('mobilephone'),
    /** Mock helper: company domain. */
    domain: text('domain'),
    createdon: ts('createdon').notNull().defaultNow(),
    modifiedon: ts('modifiedon').notNull().defaultNow(),
  },
  (t) => [index('mock_crm_contacts_domain_idx').on(t.domain)],
);

export const mockCrmActivities = pgTable(
  'mock_crm_activities',
  {
    activityid: text('activityid').primaryKey(),
    activitytype: text('activitytype').notNull().$type<'phonecall' | 'email' | 'appointment' | 'note'>(),
    regardingLeadId: text('regarding_lead_id'),
    regardingAccountId: text('regarding_account_id'),
    subject: text('subject'),
    description: text('description'),
    direction: text('direction').$type<'outgoing' | 'incoming'>(),
    ownerid: text('ownerid'),
    fromText: text('from_text'),
    toText: text('to_text'),
    phonenumber: text('phonenumber'),
    actualstart: ts('actualstart'),
    actualend: ts('actualend'),
    durationSec: integer('duration_sec'),
    scheduledstart: ts('scheduledstart'),
    scheduledend: ts('scheduledend'),
    /** 0 open, 1 completed, 2 cancelled. */
    statecode: integer('statecode').notNull().default(1),
    kls_anrufergebnis: integer('kls_anrufergebnis'),
    kls_interesse: integer('kls_interesse'),
    kls_transkript_link: text('kls_transkript_link'),
    isCampaign: boolean('is_campaign').notNull().default(false),
    campaignName: text('campaign_name'),
    campaignStep: integer('campaign_step'),
    campaignSenderName: text('campaign_sender_name'),
    campaignSenderEmail: text('campaign_sender_email'),
    campaignUseCaseIds: jsonb('campaign_use_case_ids').$type<string[]>(),
    campaignReactions: jsonb('campaign_reactions').$type<CampaignReaction[]>(),
    createdon: ts('createdon').notNull().defaultNow(),
    modifiedon: ts('modifiedon').notNull().defaultNow(),
  },
  (t) => [
    index('mock_crm_activities_lead_idx').on(t.regardingLeadId),
    index('mock_crm_activities_type_owner_idx').on(t.activitytype, t.ownerid),
  ],
);

export const mockCrmTasks = pgTable(
  'mock_crm_tasks',
  {
    activityid: text('activityid').primaryKey(),
    regardingLeadId: text('regarding_lead_id'),
    subject: text('subject').notNull(),
    description: text('description'),
    scheduledend: ts('scheduledend'),
    ownerid: text('ownerid'),
    /** 0 open, 1 completed, 2 cancelled. */
    statecode: integer('statecode').notNull().default(0),
    taskType: text('task_type').notNull().$type<'follow_up' | 'callback' | 'research' | 'other'>().default('follow_up'),
    createdon: ts('createdon').notNull().defaultNow(),
    modifiedon: ts('modifiedon').notNull().defaultNow(),
    completedon: ts('completedon'),
  },
  (t) => [index('mock_crm_tasks_owner_idx').on(t.ownerid, t.statecode), index('mock_crm_tasks_lead_idx').on(t.regardingLeadId)],
);

export const mockCalendarEvents = pgTable(
  'mock_calendar_events',
  {
    id: text('id').primaryKey(),
    mailbox: text('mailbox').notNull(),
    subject: text('subject').notNull(),
    body: text('body'),
    startAt: ts('start_at').notNull(),
    endAt: ts('end_at').notNull(),
    showAs: text('show_as').notNull().$type<'free' | 'tentative' | 'busy' | 'oof' | 'workingElsewhere'>().default('busy'),
    categories: jsonb('categories').notNull().$type<string[]>().default([]),
    isCancelled: boolean('is_cancelled').notNull().default(false),
    organizer: text('organizer'),
    attendees: jsonb('attendees').notNull().$type<CalendarAttendee[]>().default([]),
    extendedProperties: jsonb('extended_properties').notNull().$type<Record<string, string>>().default({}),
    iCalUId: text('ical_uid'),
    isOnlineMeeting: boolean('is_online_meeting').notNull().default(false),
    onlineJoinUrl: text('online_join_url'),
    /** Increments on every change (mock delta). */
    version: integer('version').notNull().default(1),
    deletedAt: ts('deleted_at'),
    lastModified: ts('last_modified').notNull().defaultNow(),
  },
  (t) => [index('mock_calendar_mailbox_idx').on(t.mailbox, t.startAt), index('mock_calendar_modified_idx').on(t.lastModified)],
);

export type BookingRulesSetting = BookingRules;

// =====================================================================================================================
// Pendenzen + Anrufhistorie (module pendenzen/history, INTENT 6.15, 6.16, 6.18)
// =====================================================================================================================

/**
 * Per-user state of portal-side Pendenzen that have no own «done» flag (briefings, bookings, cancellations, errors):
 * «erledigt» and «verschoben bis». CRM tasks are completed / rescheduled in the CRM instead.
 */
export const pendenzStates = pgTable(
  'pendenz_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `<kind>:<ref id>`, e.g. `briefing:<booking id>`. */
    itemKey: text('item_key').notNull(),
    doneAt: ts('done_at'),
    snoozedUntil: ts('snoozed_until'),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('pendenz_states_user_item_uq').on(t.userId, t.itemKey)],
);

/** Unknown callback numbers assigned to a lead by the caller (6.18 «nicht im CRM» → «einem Lead zuordnen»). Portal only. */
export const phoneAssignments = pgTable(
  'phone_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** E.164 without spaces. One lead per number (re-assigning replaces). */
    phoneE164: text('phone_e164').notNull(),
    leadId: text('lead_id').notNull(),
    leadName: text('lead_name'),
    companyName: text('company_name'),
    assignedBy: uuid('assigned_by'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('phone_assignments_phone_uq').on(t.phoneE164), index('phone_assignments_lead_idx').on(t.leadId)],
);
