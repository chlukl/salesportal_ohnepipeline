/**
 * Mock CRM on the portal DB (`mock_crm_*`). Read side complete; `applyChangeSet` is owned by the coldcall implementer.
 *
 * The data set is small (~400 leads), so queries load the relevant rows and filter/sort in memory with exactly the same
 * shared rules the live adapter must apply (grade, phones, campaign lock, real contact, exclusions).
 */
import {
  callListExclusions,
  classifyJobTitle,
  computeCampaignStatus,
  employeeBand,
  gradeFromScore,
  CALL_STATUS,
  isPortalNote,
  isRealContactActivity,
  nextAttemptAfterNotReached,
  RESULT_GROUP_CODES,
  lastRealContact,
  nationalDigits,
  normalizePhone,
  normalizeRecordPhones,
  parseAssessment,
  phoneDigits,
  pickPrimaryPhone,
  startOfZurichDay,
  type ActivityOp,
  type Actor,
  type ApplyResult,
  type CampaignMail,
  type ChangeSet,
  type CompanyPerson,
  type CrmTask,
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
  type TaskOp,
  type TimelineItem,
} from '@sales-portal/shared';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, type InferSelectModel } from 'drizzle-orm';
import { audit } from '../../lib/audit';
import { notFound } from '../../lib/errors';
import { getSetting } from '../../lib/settings';
import {
  mockCrmAccounts,
  mockCrmActivities,
  mockCrmContacts,
  mockCrmLeads,
  mockCrmTasks,
  mockCrmUsers,
} from '../../db/schema';
import type { AdapterDeps } from '../types';
import type { CrmAdapter, CrmEntity, CrmFilterOptions, CrmUser, PhoneCallPatch } from './types';

type LeadRow = InferSelectModel<typeof mockCrmLeads>;
type ActivityRow = InferSelectModel<typeof mockCrmActivities>;
type TaskRow = InferSelectModel<typeof mockCrmTasks>;
type AccountRow = InferSelectModel<typeof mockCrmAccounts>;
type ContactRow = InferSelectModel<typeof mockCrmContacts>;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

interface Dataset {
  leads: LeadRow[];
  activitiesByLead: Map<string, ActivityRow[]>;
  openTasksByLead: Map<string, TaskRow[]>;
  accounts: Map<string, AccountRow>;
  users: Map<string, CrmUser>;
  /** Admin setting `campaign.lockMonths` (INTENT 5: default 3 months without activity). */
  campaignLockMonths: number;
}

export class MockCrmAdapter implements CrmAdapter {
  readonly mode = 'mock' as const;

  constructor(private readonly deps: AdapterDeps) {}

  private get db() {
    return this.deps.db;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Loading + mapping
  // -------------------------------------------------------------------------------------------------------------------

  private async loadUsers(): Promise<Map<string, CrmUser>> {
    const rows = await this.db.select().from(mockCrmUsers);
    return new Map(rows.map((u) => [u.id, { id: u.id, fullname: u.fullname, email: u.email, title: u.title }]));
  }

  private async loadDataset(leadIds?: string[]): Promise<Dataset> {
    const leads = leadIds
      ? leadIds.length
        ? await this.db.select().from(mockCrmLeads).where(inArray(mockCrmLeads.leadid, leadIds))
        : []
      : await this.db.select().from(mockCrmLeads);
    const ids = leads.map((l) => l.leadid);
    const [activities, tasks, accounts, users, campaignLockMonths] = await Promise.all([
      leadIds
        ? ids.length
          ? this.db.select().from(mockCrmActivities).where(inArray(mockCrmActivities.regardingLeadId, ids))
          : Promise.resolve([] as ActivityRow[])
        : this.db.select().from(mockCrmActivities),
      leadIds
        ? ids.length
          ? this.db
              .select()
              .from(mockCrmTasks)
              .where(and(eq(mockCrmTasks.statecode, 0), inArray(mockCrmTasks.regardingLeadId, ids)))
          : Promise.resolve([] as TaskRow[])
        : this.db.select().from(mockCrmTasks).where(eq(mockCrmTasks.statecode, 0)),
      this.db.select().from(mockCrmAccounts),
      this.loadUsers(),
      getSetting(this.db, 'campaign.lockMonths'),
    ]);
    const activitiesByLead = new Map<string, ActivityRow[]>();
    for (const a of activities) {
      if (!a.regardingLeadId) continue;
      const list = activitiesByLead.get(a.regardingLeadId) ?? [];
      list.push(a);
      activitiesByLead.set(a.regardingLeadId, list);
    }
    const openTasksByLead = new Map<string, TaskRow[]>();
    for (const t of tasks) {
      if (!t.regardingLeadId) continue;
      const list = openTasksByLead.get(t.regardingLeadId) ?? [];
      list.push(t);
      openTasksByLead.set(t.regardingLeadId, list);
    }
    return { leads, activitiesByLead, openTasksByLead, accounts: new Map(accounts.map((a) => [a.accountid, a])), users, campaignLockMonths };
  }

  private toTimelineItem(a: ActivityRow, users: Map<string, CrmUser>): TimelineItem {
    const at = a.activitytype === 'appointment' ? (a.scheduledstart ?? a.actualstart ?? a.createdon) : (a.actualstart ?? a.createdon);
    const item: TimelineItem = {
      id: a.activityid,
      type: a.activitytype,
      at: at.toISOString(),
      subject: a.subject,
      text: a.description,
      direction: a.direction ?? null,
      ownerId: a.ownerid,
      ownerName: a.ownerid ? (users.get(a.ownerid)?.fullname ?? null) : null,
      durationSec: a.durationSec,
      resultCode: a.kls_anrufergebnis,
      interest: a.kls_interesse,
      isRealContact: false,
      isPortalNote: a.activitytype === 'note' && isPortalNote(a.description),
      isCampaign: a.isCampaign,
      campaign: a.isCampaign
        ? {
            campaignName: a.campaignName ?? '',
            step: a.campaignStep ?? 1,
            useCaseIds: a.campaignUseCaseIds ?? [],
            reactions: a.campaignReactions ?? [],
            senderName: a.campaignSenderName ?? '',
          }
        : null,
      scheduledStart: iso(a.scheduledstart),
      scheduledEnd: iso(a.scheduledend),
      statecode: a.statecode,
    };
    item.isRealContact = isRealContactActivity(item, this.deps.now());
    return item;
  }

  private toCampaignMail(a: ActivityRow): CampaignMail {
    return {
      id: a.activityid,
      leadId: a.regardingLeadId ?? '',
      campaignName: a.campaignName ?? '',
      step: a.campaignStep ?? 1,
      senderName: a.campaignSenderName ?? '',
      senderEmail: a.campaignSenderEmail,
      subject: a.subject ?? '',
      sentAt: (a.actualstart ?? a.createdon).toISOString(),
      useCaseIds: a.campaignUseCaseIds ?? [],
      reactions: a.campaignReactions ?? [],
    };
  }

  private toLead(row: LeadRow, ds: Dataset): Lead {
    const now = this.deps.now();
    const activities = (ds.activitiesByLead.get(row.leadid) ?? []).map((a) => this.toTimelineItem(a, ds.users));
    const campaignMails = (ds.activitiesByLead.get(row.leadid) ?? []).filter((a) => a.isCampaign).map((a) => this.toCampaignMail(a));
    const campaign = computeCampaignStatus({
      inCampaign: !!row.campaignName,
      campaignName: row.campaignName,
      joinedAt: iso(row.campaignJoinedAt),
      campaignMails,
      activities,
      now,
      lockMonths: ds.campaignLockMonths,
    });
    const account = row.parentaccountid ? ds.accounts.get(row.parentaccountid) : undefined;
    const phones = normalizeRecordPhones({ telephone1: row.telephone1, mobilephone: row.mobilephone });
    const openTasks = ds.openTasksByLead.get(row.leadid) ?? [];
    const nextDue = openTasks
      .map((t) => t.scheduledend?.getTime())
      .filter((t): t is number => typeof t === 'number')
      .sort((a, b) => a - b)[0];
    const record = {
      leadid: row.leadid,
      companyname: row.companyname,
      firstname: row.firstname,
      lastname: row.lastname,
      fullname: [row.firstname, row.lastname].filter(Boolean).join(' ') || null,
      jobtitle: row.jobtitle,
      emailaddress1: row.emailaddress1,
      telephone1: row.telephone1,
      mobilephone: row.mobilephone,
      websiteurl: row.websiteurl,
      numberofemployees: row.numberofemployees,
      kls_industry: row.kls_industry,
      kls_custom_industry: row.kls_custom_industry,
      kls_leadscore: row.kls_leadscore,
      kls_ki_bewertung: row.kls_ki_bewertung,
      kls_callstatus: row.kls_callstatus,
      kls_rating_category: row.kls_rating_category,
      statecode: row.statecode,
      statuscode: row.statuscode,
      ownerid: row.ownerid,
      ownerName: row.ownerid ? (ds.users.get(row.ownerid)?.fullname ?? null) : null,
      subject: row.subject,
      leadsourcecode: row.leadsourcecode,
      kls_lead_support: row.kls_lead_support,
      kls_interests: row.kls_interests ?? [],
      decisionmaker: row.decisionmaker,
      donotphone: row.donotphone,
      donotemail: row.donotemail,
      donotbulkemail: row.donotbulkemail,
      kls_competitor: row.kls_competitor,
      kls_salutation: row.kls_salutation,
      address1_postalcode: row.address1_postalcode,
      address1_city: row.address1_city,
      address1_stateorprovince: row.address1_stateorprovince,
      createdon: row.createdon.toISOString(),
      modifiedon: row.modifiedon.toISOString(),
      parentaccountid: row.parentaccountid,
    };
    return {
      ...record,
      grade: gradeFromScore(row.kls_leadscore),
      employeeBand: employeeBand(row.numberofemployees),
      orgType: row.orgType ?? 'unknown',
      contactRole: classifyJobTitle(row.jobtitle),
      phones,
      primaryPhone: pickPrimaryPhone(phones),
      domain: row.domain,
      campaign,
      lastRealContact: lastRealContact(activities, now),
      assessment: parseAssessment(row.kls_ki_bewertung),
      exclusions: callListExclusions(record, campaign, account ? { isCustomer: account.isCustomer } : null),
      nextDueAt: nextDue != null ? new Date(nextDue).toISOString() : null,
      nextAttemptAt: nextAttemptFor(row.kls_callstatus, activities),
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Leads
  // -------------------------------------------------------------------------------------------------------------------

  async listLeads(query: LeadQuery): Promise<Paged<Lead>> {
    const ds = await this.loadDataset();
    const all = ds.leads.map((r) => this.toLead(r, ds));
    const filtered = all.filter((l) => matchesQuery(l, query, this.deps.now()));
    sortLeads(filtered, query.sort ?? 'score', query.direction, this.deps.now());
    const pageSize = Math.min(Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const page = Math.max(query.page ?? 1, 1);
    return {
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length,
      page,
      pageSize,
    };
  }

  async getLead(leadId: string): Promise<Lead | null> {
    const ds = await this.loadDataset([leadId]);
    const row = ds.leads[0];
    return row ? this.toLead(row, ds) : null;
  }

  async getLeads(leadIds: string[]): Promise<Lead[]> {
    const unique = [...new Set(leadIds)];
    const ds = await this.loadDataset(unique);
    return ds.leads.map((r) => this.toLead(r, ds));
  }

  async getCompanyPersons(leadId: string): Promise<CompanyPerson[]> {
    const [current] = await this.db.select().from(mockCrmLeads).where(eq(mockCrmLeads.leadid, leadId));
    if (!current) throw notFound('Lead nicht gefunden');
    const sameCompany = current.domain
      ? await this.db.select().from(mockCrmLeads).where(eq(mockCrmLeads.domain, current.domain))
      : await this.db.select().from(mockCrmLeads).where(eq(mockCrmLeads.companyname, current.companyname));
    const ds = await this.loadDataset(sameCompany.map((l) => l.leadid));
    const leadPersons: CompanyPerson[] = ds.leads.map((row) => {
      const lead = this.toLead(row, ds);
      return {
        source: 'lead',
        id: row.leadid,
        fullName: lead.fullname ?? row.companyname,
        jobtitle: row.jobtitle,
        contactRole: lead.contactRole,
        email: row.emailaddress1,
        phones: lead.phones,
        isCurrent: row.leadid === leadId,
        statecode: row.statecode,
        statuscode: row.statuscode,
        decisionmaker: row.decisionmaker,
        lastRealContact: lead.lastRealContact,
      };
    });
    const contacts: ContactRow[] = current.domain
      ? await this.db.select().from(mockCrmContacts).where(eq(mockCrmContacts.domain, current.domain))
      : current.parentaccountid
        ? await this.db.select().from(mockCrmContacts).where(eq(mockCrmContacts.parentcustomerid, current.parentaccountid))
        : [];
    const contactPersons: CompanyPerson[] = contacts.map((c) => ({
      source: 'contact',
      id: c.contactid,
      fullName: [c.firstname, c.lastname].filter(Boolean).join(' ') || '(ohne Namen)',
      jobtitle: c.jobtitle,
      contactRole: classifyJobTitle(c.jobtitle),
      email: c.emailaddress1,
      phones: normalizeRecordPhones({ telephone1: c.telephone1, mobilephone: c.mobilephone }),
      isCurrent: false,
      statecode: null,
      statuscode: null,
      decisionmaker: null,
      lastRealContact: null,
    }));
    return [...leadPersons.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent)), ...contactPersons];
  }

  async getTimeline(leadId: string, options: { limit?: number } = {}): Promise<TimelineItem[]> {
    const users = await this.loadUsers();
    const [activities, tasks] = await Promise.all([
      this.db.select().from(mockCrmActivities).where(eq(mockCrmActivities.regardingLeadId, leadId)),
      this.db.select().from(mockCrmTasks).where(eq(mockCrmTasks.regardingLeadId, leadId)),
    ]);
    const items = activities.map((a) => this.toTimelineItem(a, users));
    for (const t of tasks) {
      items.push({
        id: t.activityid,
        type: 'task',
        at: (t.completedon ?? t.scheduledend ?? t.createdon).toISOString(),
        subject: t.subject,
        text: t.description,
        direction: null,
        ownerId: t.ownerid,
        ownerName: t.ownerid ? (users.get(t.ownerid)?.fullname ?? null) : null,
        durationSec: null,
        resultCode: null,
        interest: null,
        isRealContact: false,
        isPortalNote: false,
        isCampaign: false,
        campaign: null,
        scheduledStart: null,
        scheduledEnd: iso(t.scheduledend),
        statecode: t.statecode,
      });
    }
    items.sort((a, b) => b.at.localeCompare(a.at));
    return options.limit ? items.slice(0, options.limit) : items;
  }

  async getFieldValues(entity: CrmEntity, id: string, fields: string[]): Promise<Record<string, unknown>> {
    let row: Record<string, unknown> | undefined;
    switch (entity) {
      case 'lead':
        [row] = await this.db.select().from(mockCrmLeads).where(eq(mockCrmLeads.leadid, id));
        break;
      case 'contact':
        [row] = await this.db.select().from(mockCrmContacts).where(eq(mockCrmContacts.contactid, id));
        break;
      case 'account':
        [row] = await this.db.select().from(mockCrmAccounts).where(eq(mockCrmAccounts.accountid, id));
        break;
      case 'task':
        [row] = await this.db.select().from(mockCrmTasks).where(eq(mockCrmTasks.activityid, id));
        break;
      default:
        [row] = await this.db.select().from(mockCrmActivities).where(eq(mockCrmActivities.activityid, id));
    }
    if (!row) return {};
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const v = row[f];
      out[f] = v instanceof Date ? v.toISOString() : (v ?? null);
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Push an approved change set in one pass (OWNER: coldcall implementer).
   * Order: phone call / activities → Notiz → neue Leads → Felder → Aufgaben → Status. A failed note blocks the state
   * change (disqualify only after the note). Single failures never throw; every operation gets an OperationResult.
   * Auditing (old → new per field, with the change set id) is done by the changesets service for every adapter.
   */
  async applyChangeSet(changeSet: ChangeSet, actor: Actor): Promise<ApplyResult> {
    const results: OperationResult[] = [];
    const now = this.deps.now();
    let phonecallId: string | null = null;
    const run = async (opId: string, kind: OperationResult['kind'], fn: () => Promise<string | null | void>) => {
      try {
        const createdId = (await fn()) ?? null;
        results.push({ opId, kind, ok: true, createdId });
        return true;
      } catch (err) {
        results.push({ opId, kind, ok: false, error: safeError(err) });
        return false;
      }
    };
    const touchLead = async (leadId: string) => {
      await this.db.update(mockCrmLeads).set({ modifiedon: now }).where(eq(mockCrmLeads.leadid, leadId));
    };

    // 1. Activities (phone call of the call, e-mail activity, updates such as «zurückgesetzt»).
    for (const a of changeSet.activities) {
      await run(a.id, 'activity', async () => {
        const id = a.action === 'create' ? await this.createActivity(a, actor, now) : await this.updateActivity(a, now);
        if (a.type === 'phonecall' && a.action === 'create') phonecallId = id;
        return id;
      });
    }

    // 2. Notes («Sales-Portal: …»).
    let notesOk = true;
    for (const n of changeSet.notes) {
      const ok = await run(n.id, 'note', async () => {
        if (!n.text.trim()) throw new Error('Notiz ist leer');
        const id = randomUUID();
        await this.db.insert(mockCrmActivities).values({
          activityid: id,
          activitytype: 'note',
          regardingLeadId: n.leadId,
          subject: 'Notiz',
          description: n.text,
          ownerid: actor.crmUserId,
          actualstart: now,
          statecode: 1,
          createdon: now,
          modifiedon: now,
        });
        return id;
      });
      notesOk &&= ok;
    }

    // 3. New leads of the same company (6.8).
    for (const l of changeSet.leadCreates) {
      await run(l.id, 'lead_create', async () => {
        const [source] = await this.db.select().from(mockCrmLeads).where(eq(mockCrmLeads.leadid, l.fromLeadId));
        if (!source) throw new Error('Ursprungs-Lead nicht gefunden');
        const id = randomUUID();
        const values = leadColumns(l.fields);
        await this.db.insert(mockCrmLeads).values({
          leadid: id,
          companyname: (values.companyname as string | undefined) ?? source.companyname,
          domain: source.domain,
          orgType: source.orgType,
          websiteurl: source.websiteurl,
          address1_city: source.address1_city,
          address1_postalcode: source.address1_postalcode,
          address1_stateorprovince: source.address1_stateorprovince,
          parentaccountid: source.parentaccountid,
          ...values,
          ownerid: (values.ownerid as string | undefined) ?? actor.crmUserId,
          statecode: 0,
          statuscode: (values.statuscode as number | undefined) ?? 1,
          createdon: now,
          modifiedon: now,
        } as typeof mockCrmLeads.$inferInsert);
        return id;
      });
    }

    // 4. Fields.
    for (const op of changeSet.operations) {
      await run(op.id, 'field', async () => {
        if (op.entity !== 'lead') throw new Error(`Feld auf ${op.entity} wird nicht unterstützt`);
        if (!LEAD_WRITABLE.has(op.field as keyof LeadRecord)) throw new Error(`Feld ${op.field} ist nicht beschreibbar`);
        const [row] = await this.db.select().from(mockCrmLeads).where(eq(mockCrmLeads.leadid, op.entityId));
        if (!row) throw new Error('Lead nicht gefunden');
        const current = (row as Record<string, unknown>)[op.field];
        let value = op.newValue;
        if (op.mode === 'add_to_multiselect') {
          const add = Array.isArray(op.newValue) ? op.newValue : [op.newValue];
          const base = Array.isArray(current) ? (current as unknown[]) : [];
          value = [...base, ...add.filter((v) => !base.includes(v))];
        } else if (op.mode === 'set_if_empty' && current != null && current !== '') {
          return null;
        }
        assertColumnType(op.field as keyof LeadRecord, value);
        await this.db
          .update(mockCrmLeads)
          .set({ [op.field]: value, modifiedon: now } as Partial<LeadRow>)
          .where(eq(mockCrmLeads.leadid, op.entityId));
        return null;
      });
    }

    // 5. Tasks.
    for (const t of changeSet.tasks) {
      await run(t.id, 'task', () => this.applyTask(t, actor, now));
    }

    // 6. Status last (disqualify only after the note).
    for (const s of changeSet.stateChanges) {
      if (!notesOk) {
        results.push({ opId: s.id, kind: 'state', ok: false, error: 'Notiz fehlgeschlagen – Status nicht geändert' });
        continue;
      }
      await run(s.id, 'state', async () => {
        const updated = await this.db
          .update(mockCrmLeads)
          .set({ statecode: s.statecode, statuscode: s.statuscode, modifiedon: now })
          .where(eq(mockCrmLeads.leadid, s.leadId))
          .returning({ id: mockCrmLeads.leadid });
        if (!updated.length) throw new Error('Lead nicht gefunden');
        return null;
      });
    }

    if (results.some((r) => r.ok)) await touchLead(changeSet.leadId).catch(() => undefined);
    return { ok: results.every((r) => r.ok), results, phonecallId };
  }

  private async createActivity(a: ActivityOp, actor: Actor, now: Date): Promise<string> {
    const id = randomUUID();
    const lead = (await this.db.select().from(mockCrmLeads).where(eq(mockCrmLeads.leadid, a.leadId)))[0];
    if (!lead) throw new Error('Lead nicht gefunden');
    const person = [lead.firstname, lead.lastname].filter(Boolean).join(' ') || lead.companyname;
    await this.db.insert(mockCrmActivities).values({
      activityid: id,
      activitytype: a.type,
      regardingLeadId: a.leadId,
      subject: a.subject,
      description: a.text,
      direction: a.direction,
      ownerid: actor.crmUserId,
      fromText: a.direction === 'outgoing' ? actor.displayName : person,
      toText: a.to?.join(', ') ?? (a.direction === 'outgoing' ? person : actor.displayName),
      phonenumber: a.phoneNumber ?? null,
      actualstart: a.start ? new Date(a.start) : now,
      actualend: a.end ? new Date(a.end) : null,
      durationSec: a.durationSec ?? null,
      scheduledstart: a.type === 'appointment' && a.start ? new Date(a.start) : null,
      scheduledend: a.type === 'appointment' && a.end ? new Date(a.end) : null,
      statecode: 1,
      kls_anrufergebnis: a.resultCode ?? null,
      kls_interesse: a.interest ?? null,
      kls_transkript_link: a.transcriptLink ?? null,
      createdon: now,
      modifiedon: now,
    });
    return id;
  }

  private async updateActivity(a: ActivityOp, now: Date): Promise<string> {
    if (!a.activityId) throw new Error('Aktivität fehlt');
    const set: Partial<ActivityRow> = { modifiedon: now };
    if (a.subject) set.subject = a.subject;
    if (a.text !== undefined && a.text !== null) set.description = a.text;
    if (a.statecode != null) set.statecode = a.statecode;
    if (a.resultCode !== undefined) set.kls_anrufergebnis = a.resultCode ?? null;
    if (a.interest !== undefined) set.kls_interesse = a.interest ?? null;
    if (a.durationSec !== undefined) set.durationSec = a.durationSec ?? null;
    const updated = await this.db
      .update(mockCrmActivities)
      .set(set)
      .where(eq(mockCrmActivities.activityid, a.activityId))
      .returning({ id: mockCrmActivities.activityid });
    if (!updated.length) throw new Error('Aktivität nicht gefunden');
    return a.activityId;
  }

  private async applyTask(t: TaskOp, actor: Actor, now: Date): Promise<string | null> {
    if (t.action === 'create') {
      const id = randomUUID();
      await this.db.insert(mockCrmTasks).values({
        activityid: id,
        regardingLeadId: t.leadId,
        subject: t.subject,
        description: t.description ?? null,
        scheduledend: t.dueAt ? new Date(t.dueAt) : null,
        ownerid: t.ownerId ?? actor.crmUserId,
        statecode: 0,
        taskType: t.taskType,
        createdon: now,
        modifiedon: now,
      });
      return id;
    }
    if (!t.taskId) throw new Error('Aufgabe fehlt');
    const set: Partial<TaskRow> = { modifiedon: now };
    if (t.action === 'update') {
      set.subject = t.subject;
      if (t.description !== undefined) set.description = t.description ?? null;
      if (t.dueAt) set.scheduledend = new Date(t.dueAt);
      if (t.ownerId) set.ownerid = t.ownerId;
      set.taskType = t.taskType;
    } else if (t.action === 'complete') {
      set.statecode = 1;
      set.completedon = now;
    } else {
      set.statecode = 2;
      set.completedon = now;
    }
    const updated = await this.db
      .update(mockCrmTasks)
      .set(set)
      .where(eq(mockCrmTasks.activityid, t.taskId))
      .returning({ id: mockCrmTasks.activityid });
    if (!updated.length) throw new Error('Aufgabe nicht gefunden');
    return null;
  }

  async updatePhoneCall(phonecallId: string, patch: PhoneCallPatch, actor: Actor): Promise<void> {
    const [existing] = await this.db.select().from(mockCrmActivities).where(eq(mockCrmActivities.activityid, phonecallId));
    if (!existing || existing.activitytype !== 'phonecall') throw notFound('Telefonaktivität nicht gefunden');
    const set: Partial<ActivityRow> = { modifiedon: this.deps.now() };
    if (patch.start !== undefined) set.actualstart = patch.start ? new Date(patch.start) : null;
    if (patch.end !== undefined) set.actualend = patch.end ? new Date(patch.end) : null;
    if (patch.durationSec !== undefined) set.durationSec = patch.durationSec;
    if (patch.text !== undefined) set.description = patch.text;
    if (patch.interest !== undefined) set.kls_interesse = patch.interest;
    if (patch.resultCode !== undefined) set.kls_anrufergebnis = patch.resultCode;
    if (patch.transcriptLink !== undefined) set.kls_transkript_link = patch.transcriptLink;
    await this.db.update(mockCrmActivities).set(set).where(eq(mockCrmActivities.activityid, phonecallId));
    await audit(this.db, {
      actor: actor.kind === 'system' ? 'system' : { userId: actor.userId, displayName: actor.displayName },
      action: 'crm.phonecall_update',
      entity: 'phonecall',
      entityId: phonecallId,
      meta: { fields: Object.keys(patch) },
    });
  }

  async listTasks(filter: TaskFilter): Promise<CrmTask[]> {
    const conditions = [];
    const status = filter.status ?? 'open';
    if (status === 'open') conditions.push(eq(mockCrmTasks.statecode, 0));
    if (status === 'completed') conditions.push(eq(mockCrmTasks.statecode, 1));
    const owners = [...(filter.ownerIds ?? []), ...(filter.ownerId ? [filter.ownerId] : [])];
    if (owners.length) conditions.push(inArray(mockCrmTasks.ownerid, owners));
    if (filter.leadId) conditions.push(eq(mockCrmTasks.regardingLeadId, filter.leadId));
    const rows = await this.db
      .select()
      .from(mockCrmTasks)
      .where(conditions.length ? and(...conditions) : undefined);
    const dueBefore = filter.dueBefore ? Date.parse(filter.dueBefore) : null;
    const dueAfter = filter.dueAfter ? Date.parse(filter.dueAfter) : null;
    const selected = rows.filter((t) => {
      const due = t.scheduledend?.getTime();
      if (dueBefore != null && (due == null || due >= dueBefore)) return false;
      if (dueAfter != null && (due == null || due < dueAfter)) return false;
      return true;
    });
    const leadIds = [...new Set(selected.map((t) => t.regardingLeadId).filter((x): x is string => !!x))];
    const leads = leadIds.length ? await this.db.select().from(mockCrmLeads).where(inArray(mockCrmLeads.leadid, leadIds)) : [];
    const leadMap = new Map(leads.map((l) => [l.leadid, l]));
    const users = await this.loadUsers();
    return selected
      .map((t) => {
        const lead = t.regardingLeadId ? leadMap.get(t.regardingLeadId) : undefined;
        return {
          id: t.activityid,
          leadId: t.regardingLeadId,
          leadName: lead ? [lead.firstname, lead.lastname].filter(Boolean).join(' ') || null : null,
          companyName: lead?.companyname ?? null,
          subject: t.subject,
          description: t.description,
          dueAt: iso(t.scheduledend),
          ownerId: t.ownerid,
          ownerName: t.ownerid ? (users.get(t.ownerid)?.fullname ?? null) : null,
          statecode: t.statecode,
          taskType: t.taskType,
          createdon: t.createdon.toISOString(),
          completedon: iso(t.completedon),
        } satisfies CrmTask;
      })
      .sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'));
  }

  async completeTask(taskId: string, actor: Actor): Promise<void> {
    const [task] = await this.db.select().from(mockCrmTasks).where(eq(mockCrmTasks.activityid, taskId));
    if (!task) throw notFound('Aufgabe nicht gefunden');
    const now = this.deps.now();
    await this.db
      .update(mockCrmTasks)
      .set({ statecode: 1, completedon: now, modifiedon: now })
      .where(eq(mockCrmTasks.activityid, taskId));
    await audit(this.db, {
      actor: actor.kind === 'system' ? 'system' : { userId: actor.userId, displayName: actor.displayName },
      action: 'crm.task_complete',
      entity: 'task',
      entityId: taskId,
      field: 'statecode',
      oldValue: task.statecode,
      newValue: 1,
    });
  }

  async rescheduleTask(taskId: string, dueAt: string, actor: Actor): Promise<void> {
    const [task] = await this.db.select().from(mockCrmTasks).where(eq(mockCrmTasks.activityid, taskId));
    if (!task) throw notFound('Aufgabe nicht gefunden');
    const due = new Date(dueAt);
    await this.db
      .update(mockCrmTasks)
      .set({ scheduledend: due, modifiedon: this.deps.now() })
      .where(eq(mockCrmTasks.activityid, taskId));
    await audit(this.db, {
      actor: actor.kind === 'system' ? 'system' : { userId: actor.userId, displayName: actor.displayName },
      action: 'crm.task_reschedule',
      entity: 'task',
      entityId: taskId,
      field: 'scheduledend',
      oldValue: iso(task.scheduledend),
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

    const matches = (phone: LeadPhone): boolean => {
      const numbers = phone.status === 'ok' && phone.e164 ? [phone.e164] : phone.candidates;
      if (e164) return numbers.includes(e164);
      return numbers.some((n) => nationalDigits(n).endsWith(digits));
    };

    const [leads, contacts, accounts] = await Promise.all([
      this.db.select().from(mockCrmLeads),
      this.db.select().from(mockCrmContacts),
      this.db.select().from(mockCrmAccounts),
    ]);
    const out: PhoneMatch[] = [];
    const leadsByDomain = new Map<string, LeadRow[]>();
    for (const l of leads) {
      if (!l.domain) continue;
      leadsByDomain.set(l.domain, [...(leadsByDomain.get(l.domain) ?? []), l]);
    }
    const bestLeadFor = (domain: string | null): LeadRow | null => {
      const list = domain ? (leadsByDomain.get(domain) ?? []) : [];
      return list.find((l) => l.statecode === 0) ?? list[0] ?? null;
    };

    for (const l of leads) {
      for (const phone of normalizeRecordPhones({ telephone1: l.telephone1, mobilephone: l.mobilephone })) {
        if (!matches(phone)) continue;
        out.push({
          entity: 'lead',
          id: l.leadid,
          leadId: l.leadid,
          name: [l.firstname, l.lastname].filter(Boolean).join(' ') || l.companyname,
          companyName: l.companyname,
          field: phone.field,
          phone,
          lastCall: null,
        });
      }
    }
    for (const c of contacts) {
      for (const phone of normalizeRecordPhones({ telephone1: c.telephone1, mobilephone: c.mobilephone })) {
        if (!matches(phone)) continue;
        const lead = bestLeadFor(c.domain);
        out.push({
          entity: 'contact',
          id: c.contactid,
          leadId: lead?.leadid ?? null,
          name: [c.firstname, c.lastname].filter(Boolean).join(' ') || '(ohne Namen)',
          companyName: lead?.companyname ?? null,
          field: phone.field,
          phone,
          lastCall: null,
        });
      }
    }
    for (const a of accounts) {
      for (const phone of normalizeRecordPhones({ telephone1: a.telephone1 })) {
        if (!matches(phone)) continue;
        // Company switchboard: the lead with the same number is already listed.
        const lead = bestLeadFor(a.domain);
        if (lead && out.some((m) => m.leadId === lead.leadid && m.phone.e164 === phone.e164)) continue;
        out.push({
          entity: 'account',
          id: a.accountid,
          leadId: lead?.leadid ?? null,
          name: a.name,
          companyName: a.name,
          field: phone.field,
          phone,
          lastCall: null,
        });
      }
    }

    // Last outgoing call per lead → «warum hatte ich angerufen».
    const leadIds = [...new Set(out.map((m) => m.leadId).filter((x): x is string => !!x))];
    if (leadIds.length) {
      const calls = await this.listPhoneCallsFor(leadIds);
      for (const m of out) {
        if (!m.leadId) continue;
        m.lastCall = calls.find((c) => c.leadId === m.leadId && c.direction === 'outgoing') ?? null;
      }
    }
    return out.slice(0, 50);
  }

  async listCampaignMails(leadId: string): Promise<CampaignMail[]> {
    const rows = await this.db
      .select()
      .from(mockCrmActivities)
      .where(and(eq(mockCrmActivities.regardingLeadId, leadId), eq(mockCrmActivities.isCampaign, true)));
    return rows.map((a) => this.toCampaignMail(a)).sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  }

  private async listPhoneCallsFor(leadIds: string[]): Promise<PhoneCall[]> {
    return this.listPhoneCalls({ limit: 10_000 }).then((calls) => calls.filter((c) => c.leadId && leadIds.includes(c.leadId)));
  }

  async listPhoneCalls(filter: PhoneCallFilter): Promise<PhoneCall[]> {
    const conditions = [eq(mockCrmActivities.activitytype, 'phonecall')];
    if (filter.ownerId) conditions.push(eq(mockCrmActivities.ownerid, filter.ownerId));
    if (filter.leadId) conditions.push(eq(mockCrmActivities.regardingLeadId, filter.leadId));
    if (filter.direction) conditions.push(eq(mockCrmActivities.direction, filter.direction));
    const rows = await this.db.select().from(mockCrmActivities).where(and(...conditions));
    const from = filter.from ? Date.parse(filter.from) : null;
    const to = filter.to ? Date.parse(filter.to) : null;
    const selected = rows.filter((a) => {
      if (a.statecode === 2) return false; // cancelled («zurückgesetzt»)
      const t = (a.actualstart ?? a.createdon).getTime();
      if (from != null && t < from) return false;
      if (to != null && t >= to) return false;
      if (filter.resultCodes?.length && (a.kls_anrufergebnis == null || !filter.resultCodes.includes(a.kls_anrufergebnis))) return false;
      return true;
    });
    const leadIds = [...new Set(selected.map((a) => a.regardingLeadId).filter((x): x is string => !!x))];
    const leads = leadIds.length ? await this.db.select().from(mockCrmLeads).where(inArray(mockCrmLeads.leadid, leadIds)) : [];
    const leadMap = new Map(leads.map((l) => [l.leadid, l]));
    const users = await this.loadUsers();
    const calls = selected.map((a): PhoneCall => {
      const lead = a.regardingLeadId ? leadMap.get(a.regardingLeadId) : undefined;
      const rawNumber = a.phonenumber ?? lead?.telephone1 ?? null;
      const n = normalizePhone(rawNumber);
      return {
        id: a.activityid,
        leadId: a.regardingLeadId,
        leadName: lead ? [lead.firstname, lead.lastname].filter(Boolean).join(' ') || null : null,
        companyName: lead?.companyname ?? null,
        direction: a.direction ?? 'outgoing',
        subject: a.subject,
        text: a.description,
        phoneNumber: n.display ?? rawNumber,
        phoneE164: n.e164,
        ownerId: a.ownerid,
        ownerName: a.ownerid ? (users.get(a.ownerid)?.fullname ?? null) : null,
        start: (a.actualstart ?? a.createdon).toISOString(),
        end: iso(a.actualend),
        durationSec: a.durationSec,
        resultCode: a.kls_anrufergebnis,
        interest: a.kls_interesse,
        transcriptLink: a.kls_transkript_link,
      };
    });
    calls.sort((a, b) => b.start.localeCompare(a.start));
    return calls.slice(0, filter.limit ?? 500);
  }

  async listUsers(): Promise<CrmUser[]> {
    return [...(await this.loadUsers()).values()];
  }

  async getFilterOptions(): Promise<CrmFilterOptions> {
    const leads = await this.db.select().from(mockCrmLeads);
    const uniq = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, 'de-CH'));
    return {
      industries: uniq(leads.map((l) => l.kls_industry)),
      customIndustries: uniq(leads.map((l) => l.kls_custom_industry)),
      cantons: uniq(leads.map((l) => l.address1_stateorprovince)),
      subjects: uniq(leads.map((l) => l.subject)),
      owners: await this.listUsers(),
      campaigns: uniq(leads.map((l) => l.campaignName)),
    };
  }
}


// =====================================================================================================================
// Write helpers (coldcall implementer)
// =====================================================================================================================

/** Lead fields a change set may write (logical names = mock columns). */
const LEAD_WRITABLE = new Set<keyof LeadRecord>([
  'companyname', 'firstname', 'lastname', 'jobtitle', 'emailaddress1', 'telephone1', 'mobilephone', 'websiteurl',
  'numberofemployees', 'kls_industry', 'kls_custom_industry', 'kls_leadscore', 'kls_ki_bewertung', 'kls_callstatus',
  'kls_rating_category', 'statecode', 'statuscode', 'ownerid', 'subject', 'leadsourcecode', 'kls_lead_support',
  'kls_interests', 'decisionmaker', 'donotphone', 'donotemail', 'donotbulkemail', 'kls_competitor', 'kls_salutation',
  'address1_postalcode', 'address1_city', 'address1_stateorprovince', 'parentaccountid',
]);
const NUMBER_FIELDS = new Set<keyof LeadRecord>(['numberofemployees', 'kls_leadscore', 'kls_callstatus', 'kls_rating_category', 'statecode', 'statuscode', 'leadsourcecode', 'kls_lead_support', 'kls_salutation']);
const BOOLEAN_FIELDS = new Set<keyof LeadRecord>(['decisionmaker', 'donotphone', 'donotemail', 'donotbulkemail', 'kls_competitor']);
const NOT_NULL_FIELDS = new Set<keyof LeadRecord>(['companyname', 'statecode', 'statuscode', 'donotphone', 'donotemail', 'donotbulkemail', 'kls_interests']);

function assertColumnType(field: keyof LeadRecord, value: unknown): void {
  if (value == null) {
    if (NOT_NULL_FIELDS.has(field)) throw new Error(`Feld ${field} darf nicht leer sein`);
    return;
  }
  if (NUMBER_FIELDS.has(field) && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`Feld ${field} erwartet eine Zahl`);
  if (BOOLEAN_FIELDS.has(field) && typeof value !== 'boolean') throw new Error(`Feld ${field} erwartet Ja/Nein`);
  if (field === 'kls_interests' && (!Array.isArray(value) || value.some((v) => typeof v !== 'number'))) throw new Error('Interessen ungültig');
  if (!NUMBER_FIELDS.has(field) && !BOOLEAN_FIELDS.has(field) && field !== 'kls_interests' && typeof value !== 'string') {
    throw new Error(`Feld ${field} erwartet Text`);
  }
}

/** Only writable, well-typed columns of a LeadCreateOp. */
function leadColumns(fields: Partial<LeadRecord>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    const key = k as keyof LeadRecord;
    if (!LEAD_WRITABLE.has(key) || v === undefined) continue;
    if (v === null && NOT_NULL_FIELDS.has(key)) continue;
    assertColumnType(key, v);
    out[key] = v;
  }
  return out;
}

/** Error text for an OperationResult – German, no internals. */
function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  return /^[A-ZÄÖÜa-zäöü]/.test(message) && message.length < 200 && !/sql|select|insert|update|relation|column/i.test(message)
    ? message
    : 'Speichern im CRM fehlgeschlagen';
}

/**
 * Next attempt after «Nicht erreicht» (INTENT 6.1): only while the newest call of the lead was «Nicht erreicht»
 * (and the call status still says so) – never in the same half-day.
 */
export function nextAttemptFor(callStatus: number | null, activities: TimelineItem[]): string | null {
  if (callStatus !== CALL_STATUS.NOT_REACHED) return null;
  const calls = activities
    .filter((a) => a.type === 'phonecall' && a.statecode !== 2)
    .sort((a, b) => b.at.localeCompare(a.at));
  const last = calls[0];
  if (!last || last.resultCode !== RESULT_GROUP_CODES.not_reached) return null;
  return nextAttemptAfterNotReached(new Date(last.at)).toISOString();
}

// =====================================================================================================================
// Filtering / sorting (pure, exported for tests and the live adapter's post-filtering)
// =====================================================================================================================

export function matchesQuery(lead: Lead, q: LeadQuery, now: Date): boolean {
  // Visibility (INTENT 5): hidden leads only with includeHidden; campaign lock handled by `campaign`.
  const campaignMode = q.campaign ?? 'exclude_locked';
  if (!q.includeHidden && lead.exclusions.some((e) => e !== 'campaign_locked')) return false;
  if (campaignMode === 'exclude_locked' && lead.campaign.locked && !q.includeHidden) return false;
  if (campaignMode === 'only_locked' && !lead.campaign.locked) return false;
  if (campaignMode === 'only_from_campaign' && !lead.campaign.fromCampaign) return false;
  if (q.excludeLeadIds?.length && q.excludeLeadIds.includes(lead.leadid)) return false;
  if (q.hideRetryPending && lead.nextAttemptAt && Date.parse(lead.nextAttemptAt) > now.getTime()) return false;
  if (q.campaignNames?.length && !q.campaignNames.includes(lead.campaign.campaignName ?? '')) return false;
  if (q.requireEmail && !lead.emailaddress1) return false;

  if (q.search) {
    const s = q.search.trim().toLowerCase();
    const digits = s.replace(/\D/g, '');
    const hay = [lead.companyname, lead.fullname, lead.address1_city, lead.emailaddress1, lead.domain, lead.jobtitle]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const phoneHit =
      digits.length >= 4 && lead.phones.some((p) => (p.e164 ?? p.raw ?? '').replace(/\D/g, '').includes(digits.replace(/^0/, '')));
    if (!hay.includes(s) && !phoneHit) return false;
  }
  if (q.grades?.length && !q.grades.includes(lead.grade)) return false;
  if (q.scoreMin != null && (lead.kls_leadscore == null || lead.kls_leadscore < q.scoreMin)) return false;
  if (q.scoreMax != null && (lead.kls_leadscore == null || lead.kls_leadscore > q.scoreMax)) return false;
  if (q.employeeBands?.length && !q.employeeBands.includes(lead.employeeBand)) return false;
  if (q.industries?.length && !q.industries.includes(lead.kls_industry ?? '')) return false;
  if (q.excludeIndustries?.length && lead.kls_industry && q.excludeIndustries.includes(lead.kls_industry)) return false;
  if (q.customIndustries?.length && !q.customIndustries.includes(lead.kls_custom_industry ?? '')) return false;
  if (q.orgTypes?.length && !q.orgTypes.includes(lead.orgType)) return false;
  if (q.cantons?.length && !q.cantons.includes(lead.address1_stateorprovince ?? '')) return false;
  if (q.plzPrefixes?.length && !q.plzPrefixes.some((p) => (lead.address1_postalcode ?? '').startsWith(p))) return false;
  if (q.callStatuses?.length && (lead.kls_callstatus == null || !q.callStatuses.includes(lead.kls_callstatus))) return false;
  if (q.ratingCategories?.length && (lead.kls_rating_category == null || !q.ratingCategories.includes(lead.kls_rating_category)))
    return false;
  if (q.statusCodes?.length && !q.statusCodes.includes(lead.statuscode)) return false;
  if (q.noContactSinceDays != null && lead.lastRealContact) {
    const days = (now.getTime() - Date.parse(lead.lastRealContact.at)) / 86_400_000;
    if (days < q.noContactSinceDays) return false;
  }
  if (q.subjects?.length && !q.subjects.includes(lead.subject ?? '')) return false;
  if (q.leadSources?.length && (lead.leadsourcecode == null || !q.leadSources.includes(lead.leadsourcecode))) return false;
  if (q.leadSupport?.length && (lead.kls_lead_support == null || !q.leadSupport.includes(lead.kls_lead_support))) return false;
  if (q.contactRoles?.length && !q.contactRoles.includes(lead.contactRole)) return false;
  if (q.requirePhone && !lead.primaryPhone) return false;
  if (q.ownerIds?.length && (lead.ownerid == null || !q.ownerIds.includes(lead.ownerid))) return false;
  if (q.decisionMaker != null && (lead.decisionmaker ?? false) !== q.decisionMaker) return false;
  if (q.due) {
    const due = lead.nextDueAt ? Date.parse(lead.nextDueAt) : null;
    const startToday = startOfZurichDay(now).getTime();
    const endToday = startToday + 86_400_000;
    const endWeek = startToday + 7 * 86_400_000;
    switch (q.due) {
      case 'overdue':
        if (due == null || due >= startToday) return false;
        break;
      case 'today':
        if (due == null || due >= endToday) return false;
        break;
      case 'this_week':
        if (due == null || due >= endWeek) return false;
        break;
      case 'any_open':
        if (due == null) return false;
        break;
      case 'none':
        if (due != null) return false;
        break;
    }
  }
  return true;
}

export function sortLeads(leads: Lead[], sort: NonNullable<LeadQuery['sort']>, direction?: 'asc' | 'desc', now: Date = new Date()): void {
  // «Fällig» = due today or overdue (end of the Zurich day); future callbacks rank like any other lead.
  const dueLimit = startOfZurichDay(now).getTime() + 86_400_000;
  const dueAt = (l: Lead) => (l.nextDueAt && Date.parse(l.nextDueAt) < dueLimit ? l.nextDueAt : null);
  const dir = direction ?? (sort === 'companyname' || sort === 'city' || sort === 'nextDueAt' ? 'asc' : 'desc');
  const sign = dir === 'asc' ? 1 : -1;
  const nullsLast = <T>(a: T | null, b: T | null, cmp: (x: T, y: T) => number) => {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return sign * cmp(a, b);
  };
  const byScore = (a: Lead, b: Lead) => nullsLast(a.kls_leadscore, b.kls_leadscore, (x, y) => x - y);
  leads.sort((a, b) => {
    let r = 0;
    switch (sort) {
      case 'score':
        r = byScore(a, b);
        break;
      case 'companyname':
        r = sign * a.companyname.localeCompare(b.companyname, 'de-CH');
        break;
      case 'city':
        r = nullsLast(a.address1_city, b.address1_city, (x, y) => x.localeCompare(y, 'de-CH'));
        break;
      case 'numberofemployees':
        r = nullsLast(a.numberofemployees, b.numberofemployees, (x, y) => x - y);
        break;
      case 'lastRealContact':
        r = nullsLast(a.lastRealContact?.at ?? null, b.lastRealContact?.at ?? null, (x, y) => x.localeCompare(y));
        break;
      case 'nextDueAt':
        r = nullsLast(a.nextDueAt, b.nextDueAt, (x, y) => x.localeCompare(y));
        break;
      case 'modifiedon':
        r = sign * a.modifiedon.localeCompare(b.modifiedon);
        break;
      case 'due_then_score': {
        // Due items first (earliest first), then by score (highest first).
        const da = dueAt(a);
        const db = dueAt(b);
        if (da && db) r = da.localeCompare(db);
        else if (da) r = -1;
        else if (db) r = 1;
        else r = (b.kls_leadscore ?? -1) - (a.kls_leadscore ?? -1);
        break;
      }
    }
    return r !== 0 ? r : a.companyname.localeCompare(b.companyname, 'de-CH');
  });
}
