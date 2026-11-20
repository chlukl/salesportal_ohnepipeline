/** API shapes of /api/ai (mirror of apps/server/src/modules/ai – kept local to the ai pages). */
import type { Analysis, Booking, Briefing, CampaignMail, ChangeSet, Conflict, UseCaseMailDraft } from '@sales-portal/shared';

export interface AnalysisReviewItem {
  analysis: Analysis;
  call: {
    id: string;
    leadName: string | null;
    companyName: string | null;
    endedAt: string | null;
    durationSec: number | null;
    resultGroup: string | null;
    resultLabel: string | null;
    pushed: boolean;
  } | null;
  changeSet: ChangeSet | null;
  upcomingBookingIds: string[];
}

export type ApproveResponse =
  | { status: 'approved'; analysis: Analysis; changeSet: ChangeSet }
  | { status: 'conflict'; conflicts: Conflict[]; changeSet: ChangeSet };

export interface DraftMailResponse {
  analysis: Analysis;
  draft: UseCaseMailDraft;
  to: string | null;
  research: { requested: boolean; ok: boolean; source: string | null; error: string | null; demo: boolean };
  proposalsIncluded: boolean;
}

export interface SendMailResponse {
  analysis: Analysis;
  sent: { id: string; sentAt: string; redirected: boolean; deliveredTo: string[] };
  activity: { status: 'pushed' | 'failed' | 'conflict'; error: string | null };
}

export interface BriefingViewResponse {
  booking: Pick<Booking, 'id' | 'leadId' | 'leadName' | 'companyName' | 'start' | 'end' | 'status' | 'origin' | 'needsPreparation' | 'preparationNote' | 'briefingStatus'>;
  briefing: Briefing | null;
  generatedAt: string | null;
  analysisId: string | null;
  campaignMails: CampaignMail[];
  delivery: { mode: 'mail' | 'calendar'; mailDueAt: string | null; mailSentAt: string | null; calendarEntries: number };
  participants: { sales: string | null; specialist: string | null };
  canUpdateStatus: boolean;
}
