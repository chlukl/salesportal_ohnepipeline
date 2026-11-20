/**
 * «Echter Kontakt» and campaign lock (INTENT 5).
 *
 * Real contact = call where someone was reached (`kls_anrufergebnis` except «Nicht erreicht» / «Falsche Nummer»),
 * note with text (portal notes «Sales-Portal: …» do not count), sent mail, appointment.
 * Older calls without result count if they lasted ≥ 4 minutes.
 *
 * Campaign leads are hidden from the call list until 3 months without campaign activity: sent campaign mail, click,
 * reply, call, note with text, appointment. Opens alone do not count (unreliable tracking).
 */
import { addMonths } from 'date-fns';
import { CALL_STATUS, LEAD_SUPPORT, NOT_REACHED_RESULT_CODES, STATE, STATUS } from './i18n';
import type {
  ActivityDirection,
  ActivityType,
  CallListExclusion,
  CampaignMail,
  CampaignReactionKind,
  CampaignStatus,
  CrmId,
  IsoDateTime,
  LeadRecord,
  RealContact,
} from './types';

export const PORTAL_NOTE_PREFIX = 'Sales-Portal:';
export const LEGACY_CALL_MIN_SECONDS = 4 * 60;
export const CAMPAIGN_LOCK_MONTHS = 3;

/** Minimal activity shape needed for the rules (TimelineItem satisfies it). */
export interface ContactActivity {
  id: CrmId;
  type: ActivityType;
  at: IsoDateTime;
  direction: ActivityDirection | null;
  resultCode: number | null;
  durationSec: number | null;
  text: string | null;
  subject?: string | null;
  isCampaign: boolean;
  /** 0 open, 1 completed, 2 cancelled. */
  statecode: number;
  ownerName?: string | null;
  scheduledStart?: IsoDateTime | null;
}

export function isPortalNote(text: string | null | undefined): boolean {
  return (text ?? '').trimStart().startsWith(PORTAL_NOTE_PREFIX);
}

function hasText(text: string | null | undefined): boolean {
  return (text ?? '').trim().length > 0;
}

function toTime(iso: string | null | undefined): number {
  return iso ? new Date(iso).getTime() : Number.NaN;
}

/** Point in time that counts for an activity (appointments: start). */
function activityTime(a: ContactActivity): number {
  if (a.type === 'appointment' && a.scheduledStart) return toTime(a.scheduledStart);
  return toTime(a.at);
}

/**
 * Does this activity count as a real contact?
 * `now` is needed so future appointments do not count yet.
 */
export function isRealContactActivity(a: ContactActivity, now: Date = new Date()): boolean {
  if (a.statecode === 2) return false; // cancelled
  switch (a.type) {
    case 'phonecall':
      if (a.resultCode != null) return !NOT_REACHED_RESULT_CODES.includes(a.resultCode);
      return (a.durationSec ?? 0) >= LEGACY_CALL_MIN_SECONDS;
    case 'note':
      return hasText(a.text) && !isPortalNote(a.text);
    case 'email':
      // Sent by us (personal mail). Automated campaign mails count for the campaign lock, not as real contact.
      return a.direction === 'outgoing' && !a.isCampaign;
    case 'appointment':
      return activityTime(a) <= now.getTime();
    default:
      return false;
  }
}

/** Latest real contact of a lead (or null = never). */
export function lastRealContact(activities: ContactActivity[], now: Date = new Date()): RealContact | null {
  let best: ContactActivity | null = null;
  for (const a of activities) {
    if (!isRealContactActivity(a, now)) continue;
    if (!best || activityTime(a) > activityTime(best)) best = a;
  }
  if (!best) return null;
  const kind = best.type === 'phonecall' ? 'call' : (best.type as RealContact['kind']);
  return {
    kind,
    at: new Date(activityTime(best)).toISOString(),
    activityId: best.id,
    byName: best.ownerName ?? null,
    resultCode: best.type === 'phonecall' ? best.resultCode : null,
    summary: best.subject ?? null,
  };
}

/** Days since the last real contact (null = never). */
export function daysSinceRealContact(contact: RealContact | null, now: Date = new Date()): number | null {
  if (!contact) return null;
  return Math.floor((now.getTime() - toTime(contact.at)) / 86_400_000);
}

// ---------------------------------------------------------------------------------------------------------------------
// Campaign lock
// ---------------------------------------------------------------------------------------------------------------------

const LOCKING_REACTIONS: CampaignReactionKind[] = ['clicked', 'replied', 'replied_positive', 'replied_negative'];

/** Does a (non-campaign-mail) activity count as campaign activity for the lock? */
export function countsForCampaignLock(a: ContactActivity, now: Date = new Date()): boolean {
  if (a.statecode === 2) return false;
  switch (a.type) {
    case 'phonecall':
      return true; // any call attempt
    case 'note':
      return hasText(a.text) && !isPortalNote(a.text);
    case 'email':
      return a.direction === 'outgoing' || a.isCampaign;
    case 'appointment':
      return activityTime(a) <= now.getTime();
    default:
      return false;
  }
}

export interface CampaignStatusInput {
  /** Lead is (or was) member of the automated campaign. */
  inCampaign: boolean;
  campaignName: string | null;
  /** When the lead entered the campaign (baseline when no activity exists yet). */
  joinedAt?: IsoDateTime | null;
  campaignMails: CampaignMail[];
  /** Other activities of the lead (calls, notes, mails, appointments). Campaign mails may be included; they are deduplicated by id. */
  activities: ContactActivity[];
  now?: Date;
  lockMonths?: number;
}

export function computeCampaignStatus(input: CampaignStatusInput): CampaignStatus {
  const now = input.now ?? new Date();
  const lockMonths = input.lockMonths ?? CAMPAIGN_LOCK_MONTHS;
  const positiveReply = input.campaignMails.some((m) => m.reactions.some((r) => r.kind === 'replied_positive'));
  if (!input.inCampaign) {
    return {
      inCampaign: false,
      campaignName: null,
      lastActivityAt: null,
      lockedUntil: null,
      locked: false,
      fromCampaign: false,
      positiveReply: false,
    };
  }

  let last = Number.NEGATIVE_INFINITY;
  const consider = (t: number) => {
    if (!Number.isNaN(t) && t <= now.getTime() && t > last) last = t;
  };
  const mailIds = new Set<string>();
  for (const m of input.campaignMails) {
    mailIds.add(m.id);
    consider(toTime(m.sentAt));
    for (const r of m.reactions) if (LOCKING_REACTIONS.includes(r.kind)) consider(toTime(r.at));
  }
  if (last === Number.NEGATIVE_INFINITY && input.joinedAt) consider(toTime(input.joinedAt));

  // Other activities (calls, notes, appointments) extend the lock only while it is still running. Once the lead is
  // unlocked and Markus works it, his own calls must not hide it again (interpretation of open question 5).
  const others = input.activities
    .filter((a) => !mailIds.has(a.id) && countsForCampaignLock(a, now))
    .map(activityTime)
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  for (const t of others) {
    if (last === Number.NEGATIVE_INFINITY) {
      consider(t);
      continue;
    }
    if (t > last && t <= addMonths(new Date(last), lockMonths).getTime()) consider(t);
  }

  if (last === Number.NEGATIVE_INFINITY) {
    // In the campaign but nothing happened yet → treat as locked (mails are about to be sent).
    return {
      inCampaign: true,
      campaignName: input.campaignName,
      lastActivityAt: null,
      lockedUntil: null,
      locked: true,
      fromCampaign: false,
      positiveReply,
    };
  }
  const lastActivity = new Date(last);
  const lockedUntil = addMonths(lastActivity, lockMonths);
  const locked = lockedUntil.getTime() > now.getTime();
  return {
    inCampaign: true,
    campaignName: input.campaignName,
    lastActivityAt: lastActivity.toISOString(),
    lockedUntil: lockedUntil.toISOString(),
    locked,
    fromCampaign: !locked,
    positiveReply,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Call-list exclusions (INTENT 5 «Gesperrt / ausgeblendet»)
// ---------------------------------------------------------------------------------------------------------------------

export const EXCLUSION_LABELS: Record<CallListExclusion, string> = {
  campaign_locked: 'in automatisierter Kampagne (gesperrt)',
  divendo: 'Divendo-Coldcall',
  second_contact: 'Zweitkontakt',
  closed: 'geschlossen',
  do_not_contact: 'nicht mehr kontaktieren',
  same_domain_in_progress: 'gleiche Domain in Bearbeitung',
  existing_account: 'bestehende Firma im CRM (Besitzer informieren)',
};

export function callListExclusions(
  lead: Pick<LeadRecord, 'statecode' | 'statuscode' | 'kls_lead_support' | 'donotphone' | 'kls_callstatus'>,
  campaign: Pick<CampaignStatus, 'locked'>,
  account?: { isCustomer: boolean } | null,
): CallListExclusion[] {
  const out: CallListExclusion[] = [];
  if (campaign.locked) out.push('campaign_locked');
  if (lead.kls_lead_support === LEAD_SUPPORT.DIVENDO_COLDCALL) out.push('divendo');
  if (lead.statuscode === STATUS.SECOND_CONTACT) out.push('second_contact');
  if (lead.statecode !== STATE.OPEN) out.push('closed');
  if (lead.donotphone || lead.kls_callstatus === CALL_STATUS.DO_NOT_CONTACT) out.push('do_not_contact');
  if (lead.statuscode === STATUS.SAME_DOMAIN_IN_PROGRESS) out.push('same_domain_in_progress');
  if (lead.statuscode === STATUS.EXISTING_ACCOUNT || account?.isCustomer) out.push('existing_account');
  return out;
}
