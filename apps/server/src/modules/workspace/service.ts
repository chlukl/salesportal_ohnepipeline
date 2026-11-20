/**
 * Workspace service (OWNER: coldcall implementer): everything the Lead-Arbeitsplatz shows (INTENT 6.2, 6.13, 6.17):
 * lead + persons of the company, timeline, campaign mails, open tasks, objection answers, use-case suggestions,
 * reason for the call, the user's running call for this lead and the «3× nicht erreicht → Mail» hint.
 */
import {
  earliestNewAttempt,
  RESULT_GROUP_CODES,
  type CallSession,
  type CampaignMail,
  type CompanyPerson,
  type CrmTask,
  type Lead,
  type ObjectionAnswer,
  type TimelineItem,
} from '@sales-portal/shared';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { RequestAuth } from '../../auth/rbac';
import type { Db } from '../../db/client';
import { callSessions, objections } from '../../db/schema';
import type { Adapters } from '../../integrations';
import { notFound } from '../../lib/errors';
import { getSetting } from '../../lib/settings';
import { callReason, toCallSession } from '../calls/service';
import { suggestUseCases, type UseCaseSuggestion } from './useCases';

export interface WorkspaceData {
  lead: Lead;
  persons: CompanyPerson[];
  timeline: TimelineItem[];
  campaignMails: CampaignMail[];
  /** Open tasks of this lead (soonest first). */
  openTasks: CrmTask[];
  objections: ObjectionAnswer[];
  useCases: UseCaseSuggestion[];
  /** «Erstkontakt», «Rückruf vereinbart · aus Kampagne» … */
  callReason: string;
  /** «ab dem 3. Nicht erreicht in 14 Tagen schlägt das Portal eine Mail vor». */
  notReached: { attempts: number; windowDays: number; threshold: number; suggestMail: boolean };
  /** Waiting period after «Kein Bedarf» / «Hat Partner» (null = none). */
  contactPauseUntil: string | null;
  /** Running / unfinished call of the current user for this lead. */
  activeCall: CallSession | null;
  /** Current user may call / record results (coldcaller, admin). */
  canCall: boolean;
}

export async function loadWorkspace(adapters: Adapters, leadId: string, opts?: { db: Db; auth: RequestAuth; now: Date }): Promise<WorkspaceData> {
  const lead = await adapters.crm.getLead(leadId);
  if (!lead) throw notFound('Lead nicht gefunden');
  const [persons, timeline, campaignMails, openTasks] = await Promise.all([
    adapters.crm.getCompanyPersons(leadId),
    adapters.crm.getTimeline(leadId),
    adapters.crm.listCampaignMails(leadId),
    adapters.crm.listTasks({ leadId, status: 'open' }),
  ]);

  const now = opts?.now ?? new Date();
  const canCall = !!opts?.auth.effectiveRoles.some((r) => r === 'coldcaller' || r === 'admin');
  let objectionList: ObjectionAnswer[] = [];
  let activeCall: CallSession | null = null;
  let threshold = { attempts: 3, withinDays: 14 };
  if (opts) {
    const [obj, calls, t] = await Promise.all([
      opts.db.select().from(objections).where(eq(objections.isActive, true)).orderBy(asc(objections.sortOrder)),
      canCall
        ? opts.db
            .select()
            .from(callSessions)
            .where(and(eq(callSessions.userId, opts.auth.user.id), eq(callSessions.leadId, leadId), inArray(callSessions.status, ['dialing', 'connected', 'ended'])))
            .orderBy(desc(callSessions.createdAt))
            .limit(1)
        : Promise.resolve([]),
      getSetting(opts.db, 'calls.notReachedMailThreshold'),
    ]);
    objectionList = obj.map((o) => ({ id: o.id, key: o.key, label: o.label, answer: o.answer, sortOrder: o.sortOrder, active: o.isActive }));
    activeCall = calls[0] ? toCallSession(calls[0]) : null;
    threshold = t;
  }

  const windowStart = now.getTime() - threshold.withinDays * 86_400_000;
  const attempts = timeline.filter(
    (t) => t.type === 'phonecall' && t.statecode !== 2 && t.resultCode === RESULT_GROUP_CODES.not_reached && Date.parse(t.at) >= windowStart,
  ).length;
  const lastCall = timeline.find((t) => t.type === 'phonecall' && t.statecode !== 2 && t.resultCode != null);

  return {
    lead,
    persons,
    timeline,
    campaignMails,
    openTasks: [...openTasks].sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999')),
    objections: objectionList,
    useCases: suggestUseCases(lead, campaignMails),
    callReason: callReason(lead, now),
    notReached: { attempts, windowDays: threshold.withinDays, threshold: threshold.attempts, suggestMail: attempts >= threshold.attempts },
    contactPauseUntil: (() => {
      const until = earliestNewAttempt(lastCall?.resultCode ?? null, lastCall?.at ?? null);
      return until && Date.parse(until) > now.getTime() ? until : null;
    })(),
    activeCall,
    canCall,
  };
}
