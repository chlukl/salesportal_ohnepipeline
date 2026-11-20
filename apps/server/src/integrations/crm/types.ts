/**
 * CRM adapter contract (ARCHITECTURE §7). `mock` reads/writes `mock_crm_*`, `live` talks to the Dataverse Web API v9.2
 * with an On-Behalf-Of token of the acting user (background jobs: app token).
 */
import type {
  Actor,
  ApplyResult,
  CampaignMail,
  ChangeSet,
  CompanyPerson,
  CrmId,
  CrmTask,
  IsoDateTime,
  Lead,
  LeadQuery,
  Paged,
  PhoneCall,
  PhoneCallFilter,
  PhoneMatch,
  TaskFilter,
  TimelineItem,
} from '@sales-portal/shared';

export type CrmEntity = 'lead' | 'contact' | 'account' | 'phonecall' | 'email' | 'appointment' | 'task' | 'note';

export interface CrmUser {
  id: CrmId;
  fullname: string;
  email: string;
  title: string | null;
}

export interface CrmFilterOptions {
  industries: string[];
  customIndustries: string[];
  cantons: string[];
  subjects: string[];
  owners: CrmUser[];
  campaigns: string[];
}

export interface PhoneCallPatch {
  start?: IsoDateTime | null;
  end?: IsoDateTime | null;
  durationSec?: number | null;
  /** Replaces the description (e.g. note + approved AI summary). */
  text?: string | null;
  interest?: number | null;
  resultCode?: number | null;
  transcriptLink?: string | null;
}

export interface CrmAdapter {
  readonly mode: 'mock' | 'live';

  /** Call list: filtering, sorting, paging (INTENT 6.1). Hidden leads only with `includeHidden`. */
  listLeads(query: LeadQuery): Promise<Paged<Lead>>;
  getLead(leadId: CrmId): Promise<Lead | null>;
  /** Several leads at once (pendenzen, history); unknown ids are skipped. */
  getLeads(leadIds: CrmId[]): Promise<Lead[]>;
  /** All persons of the same company (leads + contacts, matched by domain / account / name). */
  getCompanyPersons(leadId: CrmId): Promise<CompanyPerson[]>;
  /** Notes, calls, mails, appointments, tasks – newest first. */
  getTimeline(leadId: CrmId, options?: { limit?: number }): Promise<TimelineItem[]>;
  /** Current CRM values for the conflict check (6.9). Missing record → {}. */
  getFieldValues(entity: CrmEntity, id: CrmId, fields: string[]): Promise<Record<string, unknown>>;

  /**
   * Push an approved change set in one pass: Notiz → Felder → Status (+ activities, tasks, new leads).
   * Returns ok/error per operation; never throws for single operation failures.
   */
  applyChangeSet(changeSet: ChangeSet, actor: Actor): Promise<ApplyResult>;
  /** Background update of a phone call (duration from Vera / clicks, approved analysis). No lead fields. */
  updatePhoneCall(phonecallId: CrmId, patch: PhoneCallPatch, actor: Actor): Promise<void>;

  listTasks(filter: TaskFilter): Promise<CrmTask[]>;
  completeTask(taskId: CrmId, actor: Actor): Promise<void>;
  rescheduleTask(taskId: CrmId, dueAt: IsoDateTime, actor: Actor): Promise<void>;

  /** Callback search over all phone fields of leads, contacts and accounts (input in any format, 6.18/6.19). */
  searchByPhone(input: string): Promise<PhoneMatch[]>;
  listCampaignMails(leadId: CrmId): Promise<CampaignMail[]>;
  listPhoneCalls(filter: PhoneCallFilter): Promise<PhoneCall[]>;

  listUsers(): Promise<CrmUser[]>;
  getFilterOptions(): Promise<CrmFilterOptions>;
}
