/**
 * Live CRM adapter: Dataverse Web API v9.2 (`${DATAVERSE_URL}/api/data/v9.2/…`) – ARCHITECTURE §7, INTENT 6.x/8.
 *
 * - User actions run delegated as the acting user (session tokens → OBO / refresh token, see live/tokens.ts), so
 *   owner and history in the CRM show the real person. Background jobs use the app registration.
 * - Rows are mapped with the SAME shared rules as the mock (grade, phones, campaign lock, real contact, exclusions);
 *   `matchesQuery` / `sortLeads` from mock.ts do the final filtering/sorting.
 * - listLeads pushes every filter that maps 1:1 to a column down to Dataverse ($filter), loads activities only where
 *   the rules need them (campaign leads; all candidates when sorting/filtering by «letzter echter Kontakt»; the page),
 *   and caches query results for 30 s per identity (cleared on every write of this process).
 * - applyChangeSet pushes sequentially with a result per operation, in the order Notiz → Felder → Aktivitäten →
 *   Aufgaben → neue Leads → Status. Field changes of all records go in ONE atomic `$batch` change set with
 *   If-Match ETags (re-read right before the push and compared with the draft's baseSnapshot → conflict per field).
 *   A failed step blocks the final status change (never disqualify without the note / fields).
 */
import {
  CALL_STATUS,
  callListExclusions,
  classifyJobTitle,
  computeCampaignStatus,
  employeeBand,
  gradeFromScore,
  GRADE_SCORE_RANGES,
  isRealContactActivity,
  lastRealContact,
  LEAD_SUPPORT,
  nationalDigits,
  normalizePhone,
  normalizeRecordPhones,
  optionLabel,
  parseAssessment,
  phoneDigits,
  pickPrimaryPhone,
  type Actor,
  type ApplyResult,
  type Booking,
  type CampaignMail,
  type ChangeSet,
  type CompanyPerson,
  type CrmTask,
  type FieldOp,
  type Lead,
  type LeadPhone,
  type LeadQuery,
  type LeadRecord,
  type OperationResult,
  type Paged,
  type PhoneCall,
  type PhoneCallFilter,
  type PhoneMatch,
  type TaskFilter,
  type TimelineItem,
} from '@sales-portal/shared';
import { audit, auditMany, type AuditInput } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { DataverseClient, type BatchOperation, type DvRow } from '../live/dataverse';
import {
  ACCOUNT_CUSTOMER_TYPE,
  ACCOUNT_SELECT,
  ACTIVITY_ENTITIES,
  activityPayload,
  APPOINTMENT_SELECT,
  APPOINTMENT_SELECT_LIGHT,
  closeStateOf,
  CONTACT_SELECT,
  EMAIL_SELECT,
  EMAIL_SELECT_LIGHT,
  ENTITY_SETS,
  fieldPayload,
  formatted,
  leadCreatePayload,
  LEAD_SELECT,
  lookupId,
  lookupType,
  mapAppointmentItem,
  mapEmailItem,
  mapLeadRecord,
  mapNoteItem,
  mapPhonecallItem,
  mapTask,
  mapTaskItem,
  notePayload,
  num,
  NOTE_SELECT,
  orgTypeFrom,
  parseMultiSelect,
  PHONECALL_SELECT,
  PHONECALL_SELECT_LIGHT,
  phoneMatches,
  phoneSuffixes,
  phoneVariants,
  readField,
  sameValue,
  selectNameOf,
  str,
  taskPayload,
  TASK_SELECT,
  type DvEntity,
} from '../live/dataverseMapping';
import { operationErrorText } from '../live/errors';
import { assertGuid, chunk, entityPath, f, isGuid, mapLimit } from '../live/odata';
import { getLiveRuntime, type LiveRuntime } from '../live/runtime';
import type { AdapterDeps } from '../types';
import { matchesQuery, nextAttemptFor, sortLeads } from './mock';
import type { CrmAdapter, CrmEntity, CrmFilterOptions, CrmUser, PhoneCallPatch } from './types';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_CANDIDATE_LEADS = 10_000;
const IN_CHUNK = 100;
const CONCURRENCY = 4;
/**
 * «Nicht erreicht» retry rule (INTENT 6.1): calls older than this can no longer block a lead (the next half-day after a
 * call is at most ~3.5 days later, e.g. Friday afternoon → Monday morning), so only recent calls are loaded for it.
 */
const RETRY_LOOKBACK_MS = 7 * 86_400_000;
const QUERY_TTL_MS = 30_000;
const SLOW_TTL_MS = 10 * 60_000;

// ---------------------------------------------------------------------------------------------------------------------
// Short-lived caches (module level: adapters are created per request). Keyed by identity – users only see cached
// data that was loaded with their own token.
// ---------------------------------------------------------------------------------------------------------------------

class TtlCache<T> {
  private readonly map = new Map<string, { at: number; value: Promise<T> }>();
  constructor(
    private readonly ttlMs: number,
    private readonly max = 50,
  ) {}
  get(key: string, now: number, load: () => Promise<T>): Promise<T> {
    const hit = this.map.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.value;
    const value = load();
    value.catch(() => this.map.delete(key));
    this.map.delete(key);
    this.map.set(key, { at: now, value });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return value;
  }
  clear(): void {
    this.map.clear();
  }
}

const leadQueryCache = new TtlCache<DvRow[]>(QUERY_TTL_MS, 30);
const openTaskCache = new TtlCache<Map<string, number[]>>(QUERY_TTL_MS, 20);
const customerCache = new TtlCache<Set<string>>(SLOW_TTL_MS, 20);
const userCache = new TtlCache<CrmUser[]>(SLOW_TTL_MS, 20);
const filterOptionCache = new TtlCache<CrmFilterOptions>(SLOW_TTL_MS, 20);

/** Drop all cached CRM reads (after writes, tests). */
export function invalidateLiveCrmCaches(): void {
  leadQueryCache.clear();
  openTaskCache.clear();
  customerCache.clear();
  userCache.clear();
  filterOptionCache.clear();
}

const CAMPAIGN_LABEL = optionLabel('kls_lead_support', LEAD_SUPPORT.CAMPAIGN) ?? 'Kampagne';
/** Open status code per activity entity (for reopening closed activities before an update). */
const OPEN_STATUS: Record<string, number> = { phonecall: 1, email: 1, appointment: 1, task: 2 };

/** OData filter for the pushed-down part of a LeadQuery (never stricter than `matchesQuery`). */
export function buildLeadFilter(q: LeadQuery): string {
  const ints = (values: number[] | undefined) => (values ?? []).filter((v) => Number.isInteger(v));
  const parts: (string | null)[] = [];
  if (!q.includeHidden) {
    parts.push(f.eq('statecode', 0), f.eq('donotphone', false));
  }
  if (q.scoreMin != null) parts.push(f.ge('kls_leadscore', q.scoreMin));
  if (q.scoreMax != null) parts.push(f.le('kls_leadscore', q.scoreMax));
  if (q.grades?.length) {
    parts.push(
      f.or(
        ...q.grades.map((g) =>
          g === 'unrated'
            ? f.eq('kls_leadscore', null)
            : f.and(
                // inclusive min, exclusive max; open ends are infinite
                Number.isFinite(GRADE_SCORE_RANGES[g].min) ? f.ge('kls_leadscore', GRADE_SCORE_RANGES[g].min) : f.ne('kls_leadscore', null),
                Number.isFinite(GRADE_SCORE_RANGES[g].max) ? f.lt('kls_leadscore', GRADE_SCORE_RANGES[g].max) : null,
              ),
        ),
      ),
    );
  }
  if (q.callStatuses?.length) parts.push(f.anyOf('kls_callstatus', ints(q.callStatuses)));
  if (q.ratingCategories?.length) parts.push(f.anyOf('kls_rating_category', ints(q.ratingCategories)));
  if (q.statusCodes?.length) parts.push(f.anyOf('statuscode', ints(q.statusCodes)));
  if (q.leadSources?.length) parts.push(f.anyOf('leadsourcecode', ints(q.leadSources)));
  if (q.leadSupport?.length) parts.push(f.anyOf('kls_lead_support', ints(q.leadSupport)));
  if (q.ownerIds?.length) parts.push(f.inGuids('ownerid', q.ownerIds.filter(isGuid)));
  if (q.cantons?.length) parts.push(f.anyOf('address1_stateorprovince', q.cantons));
  if (q.subjects?.length) parts.push(f.anyOf('subject', q.subjects));
  if (q.plzPrefixes?.length) parts.push(f.or(...q.plzPrefixes.map((p) => f.startswith('address1_postalcode', p))));
  if (q.decisionMaker === true) parts.push(f.eq('decisionmaker', true));
  if (q.requirePhone) parts.push(f.or(f.ne('telephone1', null), f.ne('mobilephone', null)));
  const search = q.search?.trim();
  // Searches with digits may hit phone numbers in any format → filtered in memory only.
  if (search && search.replace(/\D/g, '').length < 4) {
    parts.push(
      f.or(
        ...['companyname', 'fullname', 'address1_city', 'emailaddress1', 'websiteurl', 'jobtitle'].map((field) => f.contains(field, search.slice(0, 100))),
      ),
    );
  }
  return f.and(...parts);
}

export class LiveCrmAdapter implements CrmAdapter {
  readonly mode = 'live' as const;
  private readonly rt: LiveRuntime;
  readonly dv: DataverseClient;
  private readonly campaignSenders: Set<string>;

  constructor(
    private readonly deps: AdapterDeps,
    runtime?: LiveRuntime,
  ) {
    this.rt = runtime ?? getLiveRuntime(deps.config, deps.log);
    if (!deps.config.dataverseUrl) throw new Error('DATAVERSE_URL not configured');
    this.dv = new DataverseClient({
      url: deps.config.dataverseUrl,
      http: this.rt.http,
      getToken: () => this.rt.tokens.getToken('dataverse', deps.auth, deps.db),
      log: deps.log,
    });
    this.campaignSenders = new Set(deps.config.live.campaignSenderIds);
  }

  private get identity(): string {
    return this.deps.auth.kind === 'user' ? `u:${this.deps.auth.userId}` : 'app';
  }

  private get nowMs(): number {
    return this.deps.now().getTime();
  }

  private auditActor(actor: Actor): AuditInput['actor'] {
    return actor.kind === 'system' ? 'system' : { userId: actor.userId, displayName: actor.displayName };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Loading helpers
  // -------------------------------------------------------------------------------------------------------------------

  /** Activities (calls, mails, appointments, notes) per lead – light selects, for the rules. */
  private async loadActivities(leadIds: string[], full = false): Promise<Map<string, TimelineItem[]>> {
    const out = new Map<string, TimelineItem[]>();
    const ids = [...new Set(leadIds.filter(isGuid).map((id) => id.toLowerCase()))];
    const add = (leadId: string | null, item: TimelineItem) => {
      if (!leadId) return;
      const list = out.get(leadId) ?? [];
      list.push(item);
      out.set(leadId, list);
    };
    await mapLimit(chunk(ids, IN_CHUNK), CONCURRENCY, async (part) => {
      const regarding = f.inGuids('regardingobjectid', part);
      const [calls, mails, appts, notes] = await Promise.all([
        this.dv.list('phonecalls', { select: full ? PHONECALL_SELECT : PHONECALL_SELECT_LIGHT, filter: regarding }),
        this.dv.list('emails', { select: full ? EMAIL_SELECT : EMAIL_SELECT_LIGHT, filter: regarding }),
        this.dv.list('appointments', { select: full ? APPOINTMENT_SELECT : APPOINTMENT_SELECT_LIGHT, filter: regarding }),
        this.dv.list('annotations', { select: NOTE_SELECT, filter: f.inGuids('objectid', part) }),
      ]);
      for (const r of calls) add(lookupId(r, 'regardingobjectid'), mapPhonecallItem(r));
      for (const r of mails) add(lookupId(r, 'regardingobjectid'), mapEmailItem(r, this.campaignSenders));
      for (const r of appts) add(lookupId(r, 'regardingobjectid'), mapAppointmentItem(r));
      for (const r of notes) add(lookupId(r, 'objectid'), mapNoteItem(r));
    });
    const now = this.deps.now();
    for (const list of out.values()) for (const item of list) item.isRealContact = isRealContactActivity(item, now);
    return out;
  }

  /**
   * Recent phone calls per lead (light select, last RETRY_LOOKBACK_MS) – for the «Nicht erreicht» retry rule of
   * leads whose activities are not loaded anyway. A call counts by `actualstart ?? createdon` (= TimelineItem.at).
   */
  private async loadRecentCalls(leadIds: string[]): Promise<Map<string, TimelineItem[]>> {
    const out = new Map<string, TimelineItem[]>();
    const ids = [...new Set(leadIds.filter(isGuid).map((id) => id.toLowerCase()))];
    const since = new Date(this.nowMs - RETRY_LOOKBACK_MS);
    await mapLimit(chunk(ids, IN_CHUNK), CONCURRENCY, async (part) => {
      const rows = await this.dv.list('phonecalls', {
        select: PHONECALL_SELECT_LIGHT,
        filter: f.and(f.inGuids('regardingobjectid', part), f.or(f.ge('actualstart', since), f.ge('createdon', since))),
      });
      for (const r of rows) {
        const leadId = lookupId(r, 'regardingobjectid');
        if (!leadId) continue;
        const list = out.get(leadId) ?? [];
        list.push(mapPhonecallItem(r));
        out.set(leadId, list);
      }
    });
    return out;
  }

  /** Due dates (epoch ms) of open tasks per regarding lead. */
  private openTaskDues(): Promise<Map<string, number[]>> {
    return openTaskCache.get(this.identity, this.nowMs, async () => {
      const rows = await this.dv.list(
        'tasks',
        { select: ['activityid', 'scheduledend', '_regardingobjectid_value'], filter: f.and(f.eq('statecode', 0), f.ne('_regardingobjectid_value', null)) },
        { maxRows: 20_000 },
      );
      const map = new Map<string, number[]>();
      for (const r of rows) {
        const lead = lookupId(r, 'regardingobjectid');
        const due = str(r.scheduledend) ? Date.parse(r.scheduledend as string) : Number.NaN;
        if (!lead) continue;
        const list = map.get(lead) ?? [];
        if (!Number.isNaN(due)) list.push(due);
        map.set(lead, list);
      }
      return map;
    });
  }

  /** Account ids with customertypecode «Kunde» (exclusion «bestehende Firma im CRM»). */
  private customerAccounts(): Promise<Set<string>> {
    return customerCache.get(this.identity, this.nowMs, async () => {
      const rows = await this.dv.list('accounts', { select: ['accountid'], filter: f.eq('customertypecode', ACCOUNT_CUSTOMER_TYPE) }, { maxRows: 50_000 });
      return new Set(rows.map((r) => String(r.accountid).toLowerCase()));
    });
  }

  private campaignMailsOf(leadId: string, activities: TimelineItem[]): CampaignMail[] {
    return activities
      .filter((a) => a.type === 'email' && a.isCampaign)
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((a, i) => ({
        id: a.id,
        leadId,
        campaignName: CAMPAIGN_LABEL,
        step: i + 1,
        senderName: a.ownerName ?? '',
        senderEmail: null,
        subject: a.subject ?? '',
        sentAt: a.at,
        // Use cases and reactions are not in the CRM (Lemlist) – open question 6.
        useCaseIds: [],
        reactions: [],
      }));
  }

  private toLead(
    rec: LeadRecord & { domain: string | null },
    activities: TimelineItem[] | null,
    dues: Map<string, number[]>,
    customers: Set<string>,
    /** Phone calls for the retry rule when `activities` were not loaded for this lead (listLeads). */
    retryCalls?: TimelineItem[],
  ): Lead {
    const now = this.deps.now();
    const acts = activities ?? [];
    const { domain, ...record } = rec;
    const inCampaign = record.kls_lead_support === LEAD_SUPPORT.CAMPAIGN;
    const campaign = computeCampaignStatus({
      inCampaign,
      campaignName: inCampaign ? CAMPAIGN_LABEL : null,
      joinedAt: null,
      campaignMails: this.campaignMailsOf(record.leadid, acts),
      activities: acts,
      now,
    });
    const phones = normalizeRecordPhones({ telephone1: record.telephone1, mobilephone: record.mobilephone });
    const nextDue = [...(dues.get(record.leadid) ?? [])].sort((a, b) => a - b)[0];
    const isCustomer = !!record.parentaccountid && customers.has(record.parentaccountid);
    return {
      ...record,
      grade: gradeFromScore(record.kls_leadscore),
      employeeBand: employeeBand(record.numberofemployees),
      orgType: orgTypeFrom(record.kls_ki_bewertung),
      contactRole: classifyJobTitle(record.jobtitle),
      phones,
      primaryPhone: pickPrimaryPhone(phones),
      domain,
      campaign,
      lastRealContact: lastRealContact(acts, now),
      assessment: parseAssessment(record.kls_ki_bewertung),
      exclusions: callListExclusions(record, campaign, record.parentaccountid ? { isCustomer } : null),
      nextDueAt: nextDue != null ? new Date(nextDue).toISOString() : null,
      // Same rule as the mock: «Nicht erreicht» → not again in the same half-day (INTENT 6.1).
      nextAttemptAt: nextAttemptFor(record.kls_callstatus, retryCalls ?? acts),
    };
  }

  private async buildLeads(rows: DvRow[], loadActivitiesFor: 'all' | 'none'): Promise<Lead[]> {
    const records = rows.map(mapLeadRecord);
    const [dues, customers, acts] = await Promise.all([
      this.openTaskDues(),
      this.customerAccounts(),
      loadActivitiesFor === 'all' ? this.loadActivities(records.map((r) => r.leadid)) : Promise.resolve(new Map<string, TimelineItem[]>()),
    ]);
    return records.map((r) => this.toLead(r, acts.get(r.leadid) ?? [], dues, customers));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Leads
  // -------------------------------------------------------------------------------------------------------------------

  async listLeads(query: LeadQuery): Promise<Paged<Lead>> {
    const filter = buildLeadFilter(query);
    const rows = await leadQueryCache.get(`${this.identity}|${filter}`, this.nowMs, () =>
      this.dv.list('leads', { select: LEAD_SELECT, filter, orderby: [{ field: 'modifiedon', dir: 'desc' }] }, { maxRows: MAX_CANDIDATE_LEADS }),
    );
    if (rows.length >= MAX_CANDIDATE_LEADS) this.deps.log.warn({ max: MAX_CANDIDATE_LEADS }, 'listLeads: candidate limit reached, narrow the filter');
    const records = rows.map(mapLeadRecord);
    const needAll = query.sort === 'lastRealContact' || query.noContactSinceDays != null;
    const needIds = records.filter((r) => needAll || r.kls_lead_support === LEAD_SUPPORT.CAMPAIGN).map((r) => r.leadid);
    const loaded = new Set(needIds);
    // «Nicht erreicht» leads without loaded activities: their recent calls decide whether a retry is due yet.
    const retryIds = records.filter((r) => !loaded.has(r.leadid) && r.kls_callstatus === CALL_STATUS.NOT_REACHED).map((r) => r.leadid);
    const [dues, customers, acts, recentCalls] = await Promise.all([
      this.openTaskDues(),
      this.customerAccounts(),
      this.loadActivities(needIds),
      this.loadRecentCalls(retryIds),
    ]);
    const now = this.deps.now();
    const leads = records.map((r) =>
      this.toLead(r, acts.get(r.leadid) ?? [], dues, customers, loaded.has(r.leadid) ? undefined : (recentCalls.get(r.leadid) ?? [])),
    );
    const filtered = leads.filter((l) => matchesQuery(l, query, now));
    sortLeads(filtered, query.sort ?? 'score', query.direction);
    const pageSize = Math.min(Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const page = Math.max(query.page ?? 1, 1);
    let items = filtered.slice((page - 1) * pageSize, page * pageSize);
    // Activities for the visible page (last real contact column).
    const missing = items.filter((l) => !loaded.has(l.leadid)).map((l) => l.leadid);
    if (missing.length) {
      const pageActs = await this.loadActivities(missing);
      const byId = new Map(records.map((r) => [r.leadid, r]));
      items = items.map((l) => (loaded.has(l.leadid) ? l : this.toLead(byId.get(l.leadid)!, pageActs.get(l.leadid) ?? [], dues, customers)));
    }
    return { items, total: filtered.length, page, pageSize };
  }

  async getLead(leadId: string): Promise<Lead | null> {
    if (!isGuid(leadId)) return null;
    const res = await this.dv.get('leads', leadId, LEAD_SELECT);
    if (!res) return null;
    const [lead] = await this.buildLeads([res.row], 'all');
    return lead ?? null;
  }

  async getLeads(leadIds: string[]): Promise<Lead[]> {
    const ids = [...new Set(leadIds.filter(isGuid).map((id) => id.toLowerCase()))];
    if (!ids.length) return [];
    const rows = (
      await mapLimit(chunk(ids, IN_CHUNK), CONCURRENCY, (part) => this.dv.list('leads', { select: LEAD_SELECT, filter: f.inGuids('leadid', part) }))
    ).flat();
    return this.buildLeads(rows, 'all');
  }

  async getCompanyPersons(leadId: string): Promise<CompanyPerson[]> {
    const current = isGuid(leadId) ? await this.dv.get('leads', leadId, LEAD_SELECT) : null;
    if (!current) throw notFound('Lead nicht gefunden');
    const rec = mapLeadRecord(current.row);
    const sameCompany = f.or(
      rec.parentaccountid ? f.eq('_parentaccountid_value', { guid: rec.parentaccountid }) : null,
      rec.domain ? f.contains('websiteurl', rec.domain) : null,
      rec.domain ? f.endswith('emailaddress1', `@${rec.domain}`) : null,
      !rec.domain && !rec.parentaccountid ? f.eq('companyname', rec.companyname) : null,
    );
    const [leadRows, contactRows] = await Promise.all([
      this.dv.list('leads', { select: LEAD_SELECT, filter: sameCompany, top: 50 }),
      rec.parentaccountid || rec.domain
        ? this.dv.list('contacts', {
            select: CONTACT_SELECT,
            filter: f.and(
              f.eq('statecode', 0),
              f.or(
                rec.parentaccountid ? f.eq('_parentcustomerid_value', { guid: rec.parentaccountid }) : null,
                rec.domain ? f.endswith('emailaddress1', `@${rec.domain}`) : null,
              ),
            ),
            top: 50,
          })
        : Promise.resolve([] as DvRow[]),
    ]);
    if (!leadRows.some((r) => String(r.leadid).toLowerCase() === rec.leadid)) leadRows.unshift(current.row);
    const leads = await this.buildLeads(leadRows, 'all');
    const leadPersons: CompanyPerson[] = leads.map((lead) => ({
      source: 'lead',
      id: lead.leadid,
      fullName: lead.fullname ?? lead.companyname,
      jobtitle: lead.jobtitle,
      contactRole: lead.contactRole,
      email: lead.emailaddress1,
      phones: lead.phones,
      isCurrent: lead.leadid === rec.leadid,
      statecode: lead.statecode,
      statuscode: lead.statuscode,
      decisionmaker: lead.decisionmaker,
      lastRealContact: lead.lastRealContact,
    }));
    const contactPersons: CompanyPerson[] = contactRows.map((c) => ({
      source: 'contact',
      id: assertGuid(c.contactid),
      fullName: [str(c.firstname), str(c.lastname)].filter(Boolean).join(' ') || '(ohne Namen)',
      jobtitle: str(c.jobtitle),
      contactRole: classifyJobTitle(str(c.jobtitle)),
      email: str(c.emailaddress1),
      phones: normalizeRecordPhones({ telephone1: str(c.telephone1), mobilephone: str(c.mobilephone) }),
      isCurrent: false,
      statecode: null,
      statuscode: null,
      decisionmaker: null,
      lastRealContact: null,
    }));
    return [...leadPersons.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent)), ...contactPersons];
  }

  async getTimeline(leadId: string, options: { limit?: number } = {}): Promise<TimelineItem[]> {
    if (!isGuid(leadId)) return [];
    const id = leadId.toLowerCase();
    const regarding = f.eq('_regardingobjectid_value', { guid: id });
    const top = 200;
    const [acts, tasks] = await Promise.all([
      (async () => {
        const [calls, mails, appts, notes] = await Promise.all([
          this.dv.list('phonecalls', { select: PHONECALL_SELECT, filter: regarding, orderby: [{ field: 'createdon', dir: 'desc' }], top }),
          this.dv.list('emails', { select: EMAIL_SELECT, filter: regarding, orderby: [{ field: 'createdon', dir: 'desc' }], top }),
          this.dv.list('appointments', { select: APPOINTMENT_SELECT, filter: regarding, orderby: [{ field: 'createdon', dir: 'desc' }], top }),
          this.dv.list('annotations', { select: NOTE_SELECT, filter: f.eq('_objectid_value', { guid: id }), orderby: [{ field: 'createdon', dir: 'desc' }], top }),
        ]);
        return [
          ...calls.map(mapPhonecallItem),
          ...mails.map((r) => mapEmailItem(r, this.campaignSenders)),
          ...appts.map(mapAppointmentItem),
          ...notes.map(mapNoteItem),
        ];
      })(),
      this.dv.list('tasks', { select: TASK_SELECT, filter: regarding, orderby: [{ field: 'createdon', dir: 'desc' }], top }),
    ]);
    const now = this.deps.now();
    for (const a of acts) a.isRealContact = isRealContactActivity(a, now);
    const items = [...acts, ...tasks.map(mapTaskItem)];
    for (const item of items) {
      if (item.isCampaign) {
        const mail = this.campaignMailsOf(id, acts).find((m) => m.id === item.id);
        if (mail) item.campaign = { campaignName: mail.campaignName, step: mail.step, useCaseIds: [], reactions: [], senderName: mail.senderName };
      }
    }
    items.sort((a, b) => b.at.localeCompare(a.at));
    return options.limit ? items.slice(0, options.limit) : items;
  }

  async getFieldValues(entity: CrmEntity, id: string, fields: string[]): Promise<Record<string, unknown>> {
    if (!isGuid(id) || fields.length === 0) return {};
    const set = ENTITY_SETS[entity as DvEntity];
    if (!set) return {};
    const res = await this.dv.get(set, id, [...new Set(fields.map(selectNameOf))]);
    if (!res) return {};
    const out: Record<string, unknown> = {};
    for (const field of fields) out[field] = readField(res.row, field);
    return out;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------------------------------------------------

  /** PATCH an activity; closed activities are read-only in Dataverse → reopen, update, close again. */
  private async updateActivity(entity: DvEntity, id: string, body: DvRow): Promise<void> {
    const set = ENTITY_SETS[entity];
    const current = await this.dv.get(set, id, ['statecode', 'statuscode']);
    if (!current) throw notFound('Aktivität nicht gefunden');
    const state = num(current.row.statecode) ?? 0;
    const status = num(current.row.statuscode);
    const changesState = 'statecode' in body;
    if (state === 0 || changesState || !ACTIVITY_ENTITIES.includes(entity)) {
      await this.dv.update(set, id, body, { etag: current.etag });
      return;
    }
    await this.dv.update(set, id, { statecode: 0, statuscode: OPEN_STATUS[entity] ?? 1 }, { etag: current.etag });
    try {
      await this.dv.update(set, id, body);
    } finally {
      await this.dv.update(set, id, { statecode: state, ...(status != null ? { statuscode: status } : {}) }).catch((err: unknown) => {
        this.deps.log.warn({ entity, err: err instanceof Error ? err.name : 'Error' }, 'could not close activity again');
      });
    }
  }

  /** Field operations: re-read with ETag, conflict check against the draft snapshot, one atomic $batch change set. */
  private async applyFieldOps(cs: ChangeSet, actor: Actor, auditEntries: AuditInput[]): Promise<OperationResult[]> {
    const resultByOp = new Map<string, OperationResult>();
    const resolution = new Map(cs.conflicts.map((c) => [c.opId, c.resolution ?? null]));
    const groups = new Map<string, FieldOp[]>();
    for (const op of cs.operations) {
      const key = `${op.entity}:${op.entityId.toLowerCase()}`;
      groups.set(key, [...(groups.get(key) ?? []), op]);
    }
    const batchOps: BatchOperation[] = [];
    const batchWrites: { op: FieldOp; oldValue: unknown; newValue: unknown }[][] = [];
    const fail = (op: FieldOp, error: string) => resultByOp.set(op.id, { opId: op.id, kind: 'field', ok: false, error });
    const ok = (op: FieldOp) => resultByOp.set(op.id, { opId: op.id, kind: 'field', ok: true });

    for (const ops of groups.values()) {
      const { entity, entityId } = ops[0];
      const set = ENTITY_SETS[entity as DvEntity];
      if (!set || !isGuid(entityId)) {
        ops.forEach((op) => fail(op, 'Ungültiger Datensatz'));
        continue;
      }
      let current: Awaited<ReturnType<DataverseClient['get']>>;
      try {
        current = await this.dv.get(set, entityId, [...new Set(ops.map((o) => selectNameOf(o.field)))]);
      } catch (err) {
        ops.forEach((op) => fail(op, operationErrorText(err)));
        continue;
      }
      if (!current) {
        ops.forEach((op) => fail(op, 'Datensatz im CRM nicht gefunden'));
        continue;
      }
      const payload: DvRow = {};
      const writes: { op: FieldOp; oldValue: unknown; newValue: unknown }[] = [];
      const working = new Map<string, unknown>();
      for (const op of ops) {
        const crmNow = readField(current.row, op.field);
        const res = resolution.get(op.id);
        if (res === 'keep_crm') {
          ok(op);
          continue;
        }
        const snapKey = Object.keys(cs.baseSnapshot).find((k) => k.toLowerCase() === `${op.entity}:${entityId}:${op.field}`.toLowerCase());
        if (snapKey && !sameValue(cs.baseSnapshot[snapKey], crmNow) && res !== 'overwrite') {
          fail(op, 'Konflikt: Wert wurde seit dem Entwurf im CRM geändert');
          continue;
        }
        const before = working.has(op.field) ? working.get(op.field) : crmNow;
        let value: unknown;
        if (op.mode === 'set_if_empty') {
          if (!sameValue(before, null)) {
            ok(op); // already filled → nothing to do
            continue;
          }
          value = op.newValue;
        } else if (op.mode === 'add_to_multiselect') {
          const add = Array.isArray(op.newValue) ? op.newValue.map(Number) : parseMultiSelect(op.newValue);
          value = [...new Set([...parseMultiSelect(before), ...add])];
        } else {
          value = op.newValue;
        }
        if (sameValue(before, value)) {
          ok(op);
          continue;
        }
        try {
          Object.assign(payload, fieldPayload(op.field, value));
        } catch {
          fail(op, 'Dieses Feld kann das Portal nicht schreiben');
          continue;
        }
        working.set(op.field, value);
        writes.push({ op, oldValue: crmNow, newValue: value });
      }
      if (!writes.length) continue;
      if (ACTIVITY_ENTITIES.includes(entity as DvEntity)) {
        try {
          await this.updateActivity(entity as DvEntity, entityId, payload);
          for (const w of writes) {
            ok(w.op);
            auditEntries.push(this.fieldAudit(cs, actor, w));
          }
        } catch (err) {
          for (const w of writes) fail(w.op, operationErrorText(err));
        }
      } else {
        batchOps.push({ method: 'PATCH', path: entityPath(set, entityId), body: payload, etag: current.etag });
        batchWrites.push(writes);
      }
    }

    if (batchOps.length) {
      try {
        await this.dv.changeSet(batchOps);
        for (const writes of batchWrites)
          for (const w of writes) {
            ok(w.op);
            auditEntries.push(this.fieldAudit(cs, actor, w));
          }
      } catch (err) {
        const text = operationErrorText(err);
        for (const writes of batchWrites) for (const w of writes) fail(w.op, text);
      }
    }
    return cs.operations.map((op) => resultByOp.get(op.id) ?? { opId: op.id, kind: 'field', ok: false, error: 'nicht ausgeführt' });
  }

  private fieldAudit(cs: ChangeSet, actor: Actor, w: { op: FieldOp; oldValue: unknown; newValue: unknown }): AuditInput {
    return {
      actor: this.auditActor(actor),
      action: 'crm.field_update',
      entity: w.op.entity,
      entityId: w.op.entityId,
      field: w.op.field,
      oldValue: w.oldValue,
      newValue: w.newValue,
      changeSetId: cs.id,
    };
  }

  async applyChangeSet(cs: ChangeSet, actor: Actor): Promise<ApplyResult> {
    const results: OperationResult[] = [];
    const auditEntries: AuditInput[] = [];
    const a = this.auditActor(actor);
    let phonecallId: string | null = null;
    const run = async (opId: string, kind: OperationResult['kind'], fn: () => Promise<string | null>) => {
      try {
        const createdId = await fn();
        results.push({ opId, kind, ok: true, createdId });
      } catch (err) {
        this.deps.log.warn({ changeSetId: cs.id, opId, kind, err: err instanceof Error ? err.name : 'Error' }, 'crm push operation failed');
        results.push({ opId, kind, ok: false, error: operationErrorText(err) });
      }
    };

    try {
      // 1. Notiz
      for (const note of cs.notes) {
        await run(note.id, 'note', async () => {
          const id = await this.dv.create('annotations', notePayload(assertGuid(note.leadId), note.text));
          auditEntries.push({ actor: a, action: 'crm.note_create', entity: 'note', entityId: id, changeSetId: cs.id, meta: { leadId: note.leadId, length: note.text.length } });
          return id;
        });
      }

      // 2. Felder (atomic change set with ETags)
      if (cs.operations.length) results.push(...(await this.applyFieldOps(cs, actor, auditEntries)));

      // 3. Aktivitäten (phone call with result + note text, mails, appointments)
      for (const op of cs.activities) {
        await run(op.id, 'activity', async () => {
          const set = ENTITY_SETS[op.type];
          if (op.action === 'update') {
            const id = assertGuid(op.activityId, 'Aktivitäts-ID');
            await this.updateActivity(op.type, id, activityPayload(op, actor, 'update'));
            auditEntries.push({ actor: a, action: 'crm.activity_update', entity: op.type, entityId: id, changeSetId: cs.id, meta: { leadId: op.leadId } });
            if (op.type === 'phonecall') phonecallId ??= id;
            return null;
          }
          assertGuid(op.leadId, 'Lead-ID');
          const id = await this.dv.create(set, activityPayload(op, actor, 'create'));
          const close = closeStateOf(op.type, op.direction);
          if (close) {
            await this.dv.update(set, id, close).catch((err: unknown) => {
              this.deps.log.warn({ type: op.type, err: err instanceof Error ? err.name : 'Error' }, 'activity created but not closed');
            });
          }
          if (op.type === 'phonecall') phonecallId ??= id;
          auditEntries.push({ actor: a, action: 'crm.activity_create', entity: op.type, entityId: id, changeSetId: cs.id, meta: { leadId: op.leadId, direction: op.direction } });
          return id;
        });
      }

      // 4. Aufgaben (REGEL_AUFGABEN already applied by the caller)
      for (const op of cs.tasks) {
        await run(op.id, 'task', async () => {
          if (op.action === 'create') {
            assertGuid(op.leadId, 'Lead-ID');
            const id = await this.dv.create('tasks', taskPayload(op, 'create'));
            auditEntries.push({ actor: a, action: 'crm.task_create', entity: 'task', entityId: id, changeSetId: cs.id, newValue: op.dueAt ?? null, meta: { leadId: op.leadId } });
            return id;
          }
          const id = assertGuid(op.taskId, 'Aufgaben-ID');
          if (op.action === 'update') {
            await this.updateActivity('task', id, taskPayload(op, 'update'));
            auditEntries.push({ actor: a, action: 'crm.task_update', entity: 'task', entityId: id, field: 'scheduledend', newValue: op.dueAt ?? null, changeSetId: cs.id });
          } else {
            const state = op.action === 'complete' ? { statecode: 1, statuscode: 5 } : { statecode: 2, statuscode: 6 };
            await this.dv.update('tasks', id, state);
            auditEntries.push({ actor: a, action: `crm.task_${op.action}`, entity: 'task', entityId: id, field: 'statecode', newValue: state.statecode, changeSetId: cs.id });
          }
          return null;
        });
      }

      // 5. Neue Leads (andere Ansprechperson, 6.8)
      for (const op of cs.leadCreates) {
        await run(op.id, 'lead_create', async () => {
          const id = await this.dv.create('leads', leadCreatePayload(op.fields));
          auditEntries.push({ actor: a, action: 'crm.lead_create', entity: 'lead', entityId: id, changeSetId: cs.id, meta: { fromLeadId: op.fromLeadId } });
          return id;
        });
      }

      // 6. Status – only if everything before succeeded (disqualify never without the note / fields).
      const blocked = results.some((r) => !r.ok);
      for (const op of cs.stateChanges) {
        if (blocked) {
          results.push({ opId: op.id, kind: 'state', ok: false, error: 'Status nicht geändert, weil ein vorheriger Schritt fehlgeschlagen ist' });
          continue;
        }
        await run(op.id, 'state', async () => {
          const id = assertGuid(op.leadId, 'Lead-ID');
          const before = await this.dv.get('leads', id, ['statecode', 'statuscode']);
          if (!before) throw notFound('Lead nicht gefunden');
          await this.dv.update('leads', id, { statecode: op.statecode, statuscode: op.statuscode }, { etag: before.etag });
          auditEntries.push({
            actor: a,
            action: 'crm.state_change',
            entity: 'lead',
            entityId: id,
            field: 'statecode/statuscode',
            oldValue: { statecode: num(before.row.statecode), statuscode: num(before.row.statuscode) },
            newValue: { statecode: op.statecode, statuscode: op.statuscode },
            changeSetId: cs.id,
          });
          return null;
        });
      }
    } finally {
      invalidateLiveCrmCaches();
      await auditMany(this.deps.db, auditEntries);
    }
    return { ok: results.every((r) => r.ok), results, phonecallId };
  }

  async updatePhoneCall(phonecallId: string, patch: PhoneCallPatch, actor: Actor): Promise<void> {
    const id = assertGuid(phonecallId, 'Aktivitäts-ID');
    const body: DvRow = {};
    if (patch.start !== undefined) body.actualstart = patch.start;
    if (patch.end !== undefined) body.actualend = patch.end;
    if (patch.durationSec !== undefined) body.actualdurationminutes = patch.durationSec == null ? null : Math.max(0, Math.round(patch.durationSec / 60));
    if (patch.text !== undefined) body.description = patch.text;
    if (patch.interest !== undefined) body.kls_interesse = patch.interest;
    if (patch.resultCode !== undefined) body.kls_anrufergebnis = patch.resultCode;
    if (patch.transcriptLink !== undefined) body.kls_transkript_link = patch.transcriptLink;
    if (!Object.keys(body).length) return;
    await this.updateActivity('phonecall', id, body);
    invalidateLiveCrmCaches();
    await audit(this.deps.db, {
      actor: this.auditActor(actor),
      action: 'crm.phonecall_update',
      entity: 'phonecall',
      entityId: id,
      meta: { fields: Object.keys(patch) },
    });
  }

  async listTasks(filter: TaskFilter): Promise<CrmTask[]> {
    const status = filter.status ?? 'open';
    const owners = [...(filter.ownerIds ?? []), ...(filter.ownerId ? [filter.ownerId] : [])];
    const dueBefore = filter.dueBefore && !Number.isNaN(Date.parse(filter.dueBefore)) ? new Date(filter.dueBefore) : null;
    const dueAfter = filter.dueAfter && !Number.isNaN(Date.parse(filter.dueAfter)) ? new Date(filter.dueAfter) : null;
    const where = f.and(
      status === 'open' ? f.eq('statecode', 0) : status === 'completed' ? f.eq('statecode', 1) : null,
      owners.length ? f.inGuids('ownerid', owners.filter(isGuid)) : null,
      filter.leadId ? (isGuid(filter.leadId) ? f.eq('_regardingobjectid_value', { guid: filter.leadId }) : 'false') : null,
      dueBefore ? f.lt('scheduledend', dueBefore) : null,
      dueAfter ? f.ge('scheduledend', dueAfter) : null,
    );
    const rows = await this.dv.list('tasks', { select: TASK_SELECT, filter: where, orderby: [{ field: 'scheduledend', dir: 'asc' }] }, { maxRows: 5000 });
    const names = await this.leadNames(rows.map((r) => lookupId(r, 'regardingobjectid')).filter((x): x is string => !!x));
    return rows
      .map((r) => {
        const lead = names.get(lookupId(r, 'regardingobjectid') ?? '');
        return mapTask(r, lead ? { name: lead.name, company: lead.company } : null);
      })
      .sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'));
  }

  /** Name, company and main phone of leads (for tasks / calls lists). */
  private async leadNames(ids: string[]): Promise<Map<string, { name: string | null; company: string | null; telephone1: string | null }>> {
    const unique = [...new Set(ids.filter(isGuid).map((i) => i.toLowerCase()))];
    const out = new Map<string, { name: string | null; company: string | null; telephone1: string | null }>();
    const rows = (
      await mapLimit(chunk(unique, IN_CHUNK), CONCURRENCY, (part) =>
        this.dv.list('leads', { select: ['leadid', 'companyname', 'firstname', 'lastname', 'telephone1'], filter: f.inGuids('leadid', part) }),
      )
    ).flat();
    for (const r of rows) {
      out.set(String(r.leadid).toLowerCase(), {
        name: [str(r.firstname), str(r.lastname)].filter(Boolean).join(' ') || null,
        company: str(r.companyname),
        telephone1: str(r.telephone1),
      });
    }
    return out;
  }

  async completeTask(taskId: string, actor: Actor): Promise<void> {
    const id = isGuid(taskId) ? taskId.toLowerCase() : null;
    const current = id ? await this.dv.get('tasks', id, ['statecode']) : null;
    if (!id || !current) throw notFound('Aufgabe nicht gefunden');
    await this.dv.update('tasks', id, { statecode: 1, statuscode: 5 });
    invalidateLiveCrmCaches();
    await audit(this.deps.db, {
      actor: this.auditActor(actor),
      action: 'crm.task_complete',
      entity: 'task',
      entityId: id,
      field: 'statecode',
      oldValue: num(current.row.statecode),
      newValue: 1,
    });
  }

  async rescheduleTask(taskId: string, dueAt: string, actor: Actor): Promise<void> {
    const id = isGuid(taskId) ? taskId.toLowerCase() : null;
    const current = id ? await this.dv.get('tasks', id, ['scheduledend', 'statecode']) : null;
    if (!id || !current) throw notFound('Aufgabe nicht gefunden');
    const due = new Date(dueAt);
    if (Number.isNaN(due.getTime())) throw badRequest('Ungültiges Datum');
    await this.updateActivity('task', id, { scheduledend: due.toISOString() });
    invalidateLiveCrmCaches();
    await audit(this.deps.db, {
      actor: this.auditActor(actor),
      action: 'crm.task_reschedule',
      entity: 'task',
      entityId: id,
      field: 'scheduledend',
      oldValue: str(current.row.scheduledend),
      newValue: due.toISOString(),
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Search, campaign, calls, users
  // -------------------------------------------------------------------------------------------------------------------

  async searchByPhone(input: string): Promise<PhoneMatch[]> {
    const normalized = normalizePhone(input);
    const e164 = normalized.status === 'ok' ? normalized.e164 : null;
    const digits = phoneDigits(input).replace(/^0+/, '');
    if (!e164 && digits.length < 6) return [];
    const variants = e164 ? phoneVariants(e164) : [];
    const suffixes = phoneSuffixes(e164 ? nationalDigits(e164) : digits);
    const fieldFilter = (fields: string[]) =>
      f.or(...fields.map((field) => f.or(variants.length ? f.anyOf(field, variants) : null, ...suffixes.map((s) => f.contains(field, s)))));

    const matches = (phone: LeadPhone) => phoneMatches(phone.raw, e164, digits);
    const [leads, contacts, accounts] = await Promise.all([
      this.dv.list('leads', { select: ['leadid', 'companyname', 'firstname', 'lastname', 'telephone1', 'mobilephone', 'statecode'], filter: fieldFilter(['telephone1', 'mobilephone']), top: 200 }),
      this.dv.list('contacts', { select: CONTACT_SELECT, filter: fieldFilter(['telephone1', 'mobilephone']), top: 200 }),
      this.dv.list('accounts', { select: ACCOUNT_SELECT, filter: fieldFilter(['telephone1', 'telephone2']), top: 200 }),
    ]);

    const out: PhoneMatch[] = [];
    for (const l of leads) {
      const name = [str(l.firstname), str(l.lastname)].filter(Boolean).join(' ') || (str(l.companyname) ?? '');
      for (const phone of normalizeRecordPhones({ telephone1: str(l.telephone1), mobilephone: str(l.mobilephone) })) {
        if (!matches(phone)) continue;
        out.push({ entity: 'lead', id: assertGuid(l.leadid), leadId: assertGuid(l.leadid), name, companyName: str(l.companyname), field: phone.field, phone, lastCall: null });
      }
    }
    // Best lead of the company for contacts / accounts (open lead of the account first).
    const accountIds = [
      ...contacts.map((c) => lookupId(c, 'parentcustomerid')).filter((x): x is string => !!x),
      ...accounts.map((a) => String(a.accountid).toLowerCase()),
    ];
    const bestLead = new Map<string, { leadid: string; companyname: string | null }>();
    if (accountIds.length) {
      const rows = await this.dv.list('leads', {
        select: ['leadid', 'companyname', 'statecode', '_parentaccountid_value'],
        filter: f.inGuids('parentaccountid', [...new Set(accountIds)].slice(0, IN_CHUNK)),
        orderby: [{ field: 'statecode', dir: 'asc' }],
        top: 500,
      });
      for (const r of rows) {
        const acc = lookupId(r, 'parentaccountid');
        if (acc && !bestLead.has(acc)) bestLead.set(acc, { leadid: assertGuid(r.leadid), companyname: str(r.companyname) });
      }
    }
    for (const c of contacts) {
      const lead = bestLead.get(lookupId(c, 'parentcustomerid') ?? '') ?? null;
      for (const phone of normalizeRecordPhones({ telephone1: str(c.telephone1), mobilephone: str(c.mobilephone) })) {
        if (!matches(phone)) continue;
        out.push({
          entity: 'contact',
          id: assertGuid(c.contactid),
          leadId: lead?.leadid ?? null,
          name: [str(c.firstname), str(c.lastname)].filter(Boolean).join(' ') || '(ohne Namen)',
          companyName: lead?.companyname ?? formatted(c, '_parentcustomerid_value'),
          field: phone.field,
          phone,
          lastCall: null,
        });
      }
    }
    for (const acc of accounts) {
      const accountId = String(acc.accountid).toLowerCase();
      const lead = bestLead.get(accountId) ?? null;
      for (const phone of normalizeRecordPhones({ telephone1: str(acc.telephone1), telephone2: str(acc.telephone2) })) {
        if (!matches(phone)) continue;
        if (lead && out.some((m) => m.leadId === lead.leadid && m.phone.e164 === phone.e164)) continue;
        out.push({ entity: 'account', id: assertGuid(acc.accountid), leadId: lead?.leadid ?? null, name: str(acc.name) ?? '', companyName: str(acc.name), field: phone.field, phone, lastCall: null });
      }
    }

    // Last outgoing call per lead → «warum hatte ich angerufen».
    const leadIds = [...new Set(out.map((m) => m.leadId).filter((x): x is string => !!x))];
    if (leadIds.length) {
      const calls = await this.phoneCallsWhere(f.and(f.inGuids('regardingobjectid', leadIds.slice(0, IN_CHUNK)), f.eq('directioncode', true)), 500);
      for (const m of out) if (m.leadId) m.lastCall = calls.find((c) => c.leadId === m.leadId) ?? null;
    }
    return out.slice(0, 50);
  }

  async listCampaignMails(leadId: string): Promise<CampaignMail[]> {
    if (!isGuid(leadId) || this.campaignSenders.size === 0) return [];
    const senders = [...this.campaignSenders];
    const rows = await this.dv.list('emails', {
      select: EMAIL_SELECT_LIGHT,
      filter: f.and(f.eq('_regardingobjectid_value', { guid: leadId }), f.or(f.inGuids('createdby', senders), f.inGuids('ownerid', senders))),
      orderby: [{ field: 'createdon', dir: 'asc' }],
      top: 100,
    });
    const items = rows.map((r) => mapEmailItem(r, this.campaignSenders));
    return this.campaignMailsOf(leadId.toLowerCase(), items).map((m, i) => ({ ...m, senderEmail: str(rows[i]?.sender) }));
  }

  private async phoneCallsWhere(where: string, limit: number): Promise<PhoneCall[]> {
    const rows = await this.dv.list('phonecalls', { select: PHONECALL_SELECT, filter: where, orderby: [{ field: 'createdon', dir: 'desc' }] }, { maxRows: limit });
    const leadIds = rows
      .filter((r) => (lookupType(r, 'regardingobjectid') ?? 'lead') === 'lead')
      .map((r) => lookupId(r, 'regardingobjectid'))
      .filter((x): x is string => !!x);
    const names = await this.leadNames(leadIds);
    return rows.map((r): PhoneCall => {
      const item = mapPhonecallItem(r);
      const leadId = lookupId(r, 'regardingobjectid');
      const lead = leadId ? names.get(leadId) : undefined;
      const rawNumber = str(r.phonenumber) ?? lead?.telephone1 ?? null;
      const n = normalizePhone(rawNumber);
      return {
        id: item.id,
        leadId: lead ? leadId : null,
        leadName: lead?.name ?? null,
        companyName: lead?.company ?? null,
        direction: item.direction ?? 'outgoing',
        subject: item.subject,
        text: item.text,
        phoneNumber: n.display ?? rawNumber,
        phoneE164: n.e164,
        ownerId: item.ownerId,
        ownerName: item.ownerName,
        start: item.at,
        end: str(r.actualend) ? new Date(r.actualend as string).toISOString() : null,
        durationSec: item.durationSec,
        resultCode: item.resultCode,
        interest: item.interest,
        transcriptLink: str(r.kls_transkript_link),
      };
    });
  }

  async listPhoneCalls(filter: PhoneCallFilter): Promise<PhoneCall[]> {
    const from = filter.from && !Number.isNaN(Date.parse(filter.from)) ? new Date(filter.from) : null;
    const to = filter.to && !Number.isNaN(Date.parse(filter.to)) ? new Date(filter.to) : null;
    const where = f.and(
      filter.ownerId ? (isGuid(filter.ownerId) ? f.eq('_ownerid_value', { guid: filter.ownerId }) : 'false') : null,
      filter.leadId ? (isGuid(filter.leadId) ? f.eq('_regardingobjectid_value', { guid: filter.leadId }) : 'false') : null,
      filter.direction ? f.eq('directioncode', filter.direction === 'outgoing') : null,
      from ? f.or(f.ge('actualstart', from), f.and(f.eq('actualstart', null), f.ge('createdon', from))) : null,
      to ? f.or(f.lt('actualstart', to), f.and(f.eq('actualstart', null), f.lt('createdon', to))) : null,
      filter.resultCodes?.length ? f.anyOf('kls_anrufergebnis', filter.resultCodes.filter(Number.isInteger)) : null,
    );
    const calls = await this.phoneCallsWhere(where, Math.min(Math.max(filter.limit ?? 500, 1), 5000));
    calls.sort((a, b) => b.start.localeCompare(a.start));
    return calls;
  }

  async listUsers(): Promise<CrmUser[]> {
    return userCache.get(this.identity, this.nowMs, async () => {
      const rows = await this.dv.list(
        'systemusers',
        { select: ['systemuserid', 'fullname', 'internalemailaddress', 'title'], filter: f.and(f.eq('isdisabled', false), f.eq('accessmode', 0)), orderby: [{ field: 'fullname' }] },
        { maxRows: 2000 },
      );
      return rows.map((r) => ({ id: assertGuid(r.systemuserid), fullname: str(r.fullname) ?? '', email: str(r.internalemailaddress) ?? '', title: str(r.title) }));
    });
  }

  async getFilterOptions(): Promise<CrmFilterOptions> {
    return filterOptionCache.get(this.identity, this.nowMs, async () => {
      const [rows, owners] = await Promise.all([
        this.dv.list(
          'leads',
          { select: ['kls_industry', 'kls_custom_industry', 'address1_stateorprovince', 'subject', 'kls_lead_support'], filter: f.eq('statecode', 0) },
          { maxRows: 20_000 },
        ),
        this.listUsers(),
      ]);
      const uniq = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, 'de-CH'));
      return {
        industries: uniq(rows.map((r) => formatted(r, 'kls_industry') ?? str(r.kls_industry))),
        customIndustries: uniq(rows.map((r) => formatted(r, 'kls_custom_industry') ?? str(r.kls_custom_industry))),
        cantons: uniq(rows.map((r) => str(r.address1_stateorprovince))),
        subjects: uniq(rows.map((r) => str(r.subject))),
        owners,
        campaigns: rows.some((r) => num(r.kls_lead_support) === LEAD_SUPPORT.CAMPAIGN) ? [CAMPAIGN_LABEL] : [],
      };
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // kls_buchung (FixCRMSolution, INTENT 8) – not part of CrmAdapter; used by scheduling via `instanceof LiveCrmAdapter`.
  // ASSUMED column names – verify against the sandbox metadata before go-live.
  // -------------------------------------------------------------------------------------------------------------------

  /** Create or update the booking row; returns its id (store in `bookings.crm_booking_id`). */
  async upsertBooking(booking: Booking, crmBookingId: string | null, actor: Actor): Promise<string> {
    const set = this.deps.config.live.bookingEntitySet;
    const body = bookingPayload(booking);
    let id: string;
    if (crmBookingId && isGuid(crmBookingId)) {
      id = crmBookingId.toLowerCase();
      await this.dv.update(set, id, body);
    } else {
      id = await this.dv.create(set, { ...body, 'kls_lead@odata.bind': `/leads(${assertGuid(booking.leadId, 'Lead-ID')})` });
    }
    await audit(this.deps.db, {
      actor: this.auditActor(actor),
      action: crmBookingId ? 'crm.booking_update' : 'crm.booking_create',
      entity: 'kls_buchung',
      entityId: id,
      field: 'kls_status',
      newValue: booking.status,
      meta: { bookingRef: booking.bookingRef },
    });
    return id;
  }
}

/** ASSUMED option codes of kls_buchung (status / origin). */
export const BOOKING_STATUS_CODES: Record<Booking['status'], number> = { booked: 845140000, cancelled: 845140001, rescheduled: 845140002, held: 845140003 };
export const BOOKING_ORIGIN_CODES: Record<Booking['origin'], number> = { coldcall: 845140000, campaign: 845140001, other: 845140002 };

export function bookingPayload(b: Booking): DvRow {
  return {
    kls_name: b.subject.slice(0, 100),
    kls_terminid: b.bookingRef,
    kls_icaluid: b.iCalUId,
    kls_eventid: b.eventId,
    kls_start: b.start,
    kls_end: b.end,
    kls_status: BOOKING_STATUS_CODES[b.status],
    kls_herkunft: BOOKING_ORIGIN_CODES[b.origin],
    kls_blockerids: b.blockerEventIds.join(';').slice(0, 4000) || null,
  };
}
