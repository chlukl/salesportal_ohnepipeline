/**
 * Pure Pendenzen rules (INTENT 6.16): due buckets, origin, unfinished calls, ordering, filters.
 * No I/O here – the service collects the sources, these functions decide.
 */
import {
  startOfZurichDay,
  zurichDate,
  zurichTime,
  type PendenzDue,
  type PendenzEntry,
  type PendenzFilter,
  type PendenzKind,
  type PendenzOrigin,
  type Role,
} from '@sales-portal/shared';

export const PENDENZ_KINDS: PendenzKind[] = [
  'unfinished_call',
  'task',
  'analysis',
  'approval',
  'error',
  'cancellation',
  'booking',
  'briefing',
  'campaign_reply',
];

export const PENDENZ_DUES: PendenzDue[] = ['overdue', 'today', 'this_week', 'later', 'none'];

const DAY_MS = 86_400_000;

/** Monday 00:00 (Zurich) of the week after `now`. */
export function startOfNextZurichWeek(now: Date): Date {
  const iso = zurichDate(now);
  // Day of week of the Zurich calendar date (0 = Sunday) – computed on the date itself, independent of the server TZ.
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
  const daysToMonday = dow === 0 ? 1 : 8 - dow;
  const next = new Date(Date.parse(`${iso}T12:00:00Z`) + daysToMonday * DAY_MS).toISOString().slice(0, 10);
  return zurichTime(next, '00:00');
}

/**
 * Fälligkeit (Europe/Zurich, calendar days):
 * before today → overdue · today → today · until Sunday of this week → this_week · after → later · no date → none.
 */
export function classifyDue(dueAt: string | Date | null | undefined, now: Date): PendenzDue {
  if (!dueAt) return 'none';
  const due = typeof dueAt === 'string' ? new Date(dueAt) : dueAt;
  if (Number.isNaN(due.getTime())) return 'none';
  const today = startOfZurichDay(now).getTime();
  const tomorrow = startOfZurichDay(new Date(today + DAY_MS + 3 * 3_600_000)).getTime();
  const t = due.getTime();
  if (t < today) return 'overdue';
  if (t < tomorrow) return 'today';
  if (t < startOfNextZurichWeek(now).getTime()) return 'this_week';
  return 'later';
}

/** Herkunft: booking origin wins; campaign leads → campaign; coldcall process items → coldcall; else other. */
export function deriveOrigin(input: {
  kind: PendenzKind;
  bookingOrigin?: PendenzOrigin | null;
  leadFromCampaign?: boolean | null;
  /** The item stems from the coldcall process (call session, analysis, change set, callback task of a coldcaller). */
  fromColdcall?: boolean;
}): PendenzOrigin {
  if (input.bookingOrigin) return input.bookingOrigin;
  if (input.leadFromCampaign) return 'campaign';
  if (input.kind === 'campaign_reply') return 'campaign';
  if (input.fromColdcall || ['unfinished_call', 'analysis', 'approval'].includes(input.kind)) return 'coldcall';
  return 'other';
}

export interface SessionLike {
  id: string;
  direction: 'outbound' | 'inbound';
  category: 'outbound' | 'callback_answered' | 'callback_missed' | 'unknown_number';
  status: 'dialing' | 'connected' | 'ended' | 'not_reached' | 'completed' | 'abandoned';
  resultGroup: string | null;
  crmPhonecallId: string | null;
  changeSetId: string | null;
}

/**
 * «Unabgeschlossener Anruf» (6.16): a call that was made or taken but has no CRM entry yet –
 * no result chosen, or a result whose change set is not pushed. Missed callbacks / unknown numbers are history items,
 * abandoned sessions were discarded on purpose.
 */
export function isUnfinishedCall(session: SessionLike, changeSetStatus: string | null | undefined): boolean {
  if (session.category === 'callback_missed' || session.category === 'unknown_number') return false;
  if (session.status === 'abandoned') return false;
  if (session.crmPhonecallId) return false;
  if (session.changeSetId && changeSetStatus === 'pushed') return false;
  if (session.changeSetId && changeSetStatus === 'discarded') return false;
  return true;
}

const DUE_ORDER: Record<PendenzDue, number> = { overdue: 0, today: 1, none: 2, this_week: 3, later: 4 };

/** Rank within open items; coldcaller: unfinished calls, due callbacks and due tasks on top (6.16). */
export function pendenzRank(item: Pick<PendenzEntry, 'kind' | 'due' | 'taskType'>, coldcallerFirst: boolean): number {
  const dueNow = item.due === 'overdue' || item.due === 'today';
  if (coldcallerFirst) {
    if (item.kind === 'unfinished_call') return 0;
    if (item.kind === 'task' && item.taskType === 'callback' && dueNow) return 1;
    if (item.kind === 'task' && dueNow) return 2;
    if (item.kind === 'error') return 3;
    if (item.kind === 'approval' || item.kind === 'analysis') return 4;
    if (item.kind === 'cancellation' || item.kind === 'campaign_reply') return 5;
    return 6;
  }
  if (item.kind === 'error' || item.kind === 'cancellation') return 0;
  if (item.kind === 'unfinished_call') return 1;
  return 2;
}

export function sortPendenzen<T extends Pick<PendenzEntry, 'kind' | 'due' | 'taskType' | 'status' | 'dueAt'>>(items: T[], coldcallerFirst: boolean): T[] {
  return [...items].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    const r = pendenzRank(a, coldcallerFirst) - pendenzRank(b, coldcallerFirst);
    if (r !== 0) return r;
    const d = DUE_ORDER[a.due] - DUE_ORDER[b.due];
    if (d !== 0) return d;
    const at = a.dueAt ?? '9999';
    const bt = b.dueAt ?? '9999';
    return a.status === 'done' ? bt.localeCompare(at) : at.localeCompare(bt);
  });
}

/** All filters except `kinds` (used for the tab counts). */
export function matchesBaseFilter(item: PendenzEntry, filter: PendenzFilter): boolean {
  const status = filter.status ?? 'open';
  if (status !== 'all' && item.status !== status) return false;
  if (filter.due?.length && !filter.due.includes(item.due)) return false;
  if (filter.origins?.length && !filter.origins.includes(item.origin)) return false;
  if (filter.company?.trim()) {
    const q = filter.company.trim().toLocaleLowerCase('de-CH');
    const hay = `${item.companyName ?? ''} ${item.title} ${item.subtitle ?? ''}`.toLocaleLowerCase('de-CH');
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function applyFilter(items: PendenzEntry[], filter: PendenzFilter): { items: PendenzEntry[]; counts: Record<PendenzKind, number> } {
  const base = items.filter((i) => matchesBaseFilter(i, filter));
  const counts = Object.fromEntries(PENDENZ_KINDS.map((k) => [k, 0])) as Record<PendenzKind, number>;
  for (const i of base) counts[i.kind] += 1;
  const kinds = filter.kinds?.length ? filter.kinds : null;
  return { items: kinds ? base.filter((i) => kinds.includes(i.kind)) : base, counts };
}

/** Which sources a person gets, by role (INTENT 3 / 6.16). */
export interface PendenzScope {
  /** Own CRM tasks (all roles that work with the CRM). */
  tasks: boolean;
  /** Coldcall items: unfinished calls, analyses, approvals, own change-set errors, cancellations of own bookings. */
  coldcall: boolean;
  /** Bookings + briefings where the person is the booked sales. */
  salesBookings: boolean;
  /** All first meetings + briefings (AI specialist, 6.16 «Nico sieht alle Erstgespräche»). */
  allBookings: boolean;
  /** Admin: failed CRM pushes of everyone. */
  allErrors: boolean;
}

export function scopeForRoles(roles: Role[]): PendenzScope {
  return {
    tasks: roles.length > 0,
    coldcall: roles.includes('coldcaller'),
    salesBookings: roles.includes('sales'),
    allBookings: roles.includes('ai_specialist'),
    allErrors: roles.includes('admin'),
  };
}

/** Who can book a new meeting (same roles as the scheduling module's booking routes: ROLESETS.coldcall). */
export function canReplanBookings(roles: Role[]): boolean {
  return roles.includes('coldcaller') || roles.includes('admin');
}

/**
 * Pendenz «Termin abgesagt / verschoben»: link + subtitle hint. Only persons who can book get «neu planen» and a link
 * straight into the workspace's Termin tab (`?panel=scheduling`); for Sales / AI specialist it is information only.
 */
export function cancellationTarget(input: { leadId: string; cancelled: boolean; canReplan: boolean }): { link: string; replan: boolean } {
  const replan = input.cancelled && input.canReplan;
  return { link: replan ? `/lead/${input.leadId}?panel=scheduling` : `/lead/${input.leadId}`, replan };
}

/** Header counter: open items that need attention now (due today/overdue or without date). Analyses have their own counter. */
export function countsForHeader(items: Pick<PendenzEntry, 'kind' | 'due' | 'status'>[]): number {
  return items.filter((i) => i.status === 'open' && i.kind !== 'analysis' && i.kind !== 'booking' && (i.due === 'overdue' || i.due === 'today' || i.due === 'none')).length;
}
