import type { CallSession, CampaignMail, CompanyPerson, CrmTask, Lead, ObjectionAnswer, TimelineItem } from '@sales-portal/shared';

/** GET /api/workspace/:leadId (server: modules/workspace/service.ts). */
export interface WorkspaceData {
  lead: Lead;
  persons: CompanyPerson[];
  timeline: TimelineItem[];
  campaignMails: CampaignMail[];
  openTasks: CrmTask[];
  objections: ObjectionAnswer[];
  useCases: { id: string; label: string; why: string }[];
  callReason: string;
  notReached: { attempts: number; windowDays: number; threshold: number; suggestMail: boolean };
  contactPauseUntil: string | null;
  activeCall: CallSession | null;
  canCall: boolean;
}

export type RightTab = 'result' | 'scheduling' | 'proposals' | 'mail';
