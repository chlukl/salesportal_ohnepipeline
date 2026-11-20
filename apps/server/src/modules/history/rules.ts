/**
 * Pure Anrufhistorie rules (INTENT 6.15, 6.18): merge CRM phone calls with portal call sessions, categorize,
 * decide which missed callbacks are still open, filter and search.
 */
import {
  CALL_CATEGORY_LABELS,
  formatPhoneDisplay,
  nationalDigits,
  normalizePhone,
  phoneDigits,
  RESULT_GROUP_CODES,
  zurichDate,
  type CallCategory,
  type CallDirection,
  type HistoryRow,
  type PhoneCall,
  type ResultGroupKey,
} from '@sales-portal/shared';

export const CALL_CATEGORIES = Object.keys(CALL_CATEGORY_LABELS) as CallCategory[];

/** Subset of a `call_sessions` row the history needs. */
export interface HistorySession {
  id: string;
  leadId: string | null;
  leadName: string | null;
  companyName: string | null;
  phoneE164: string | null;
  phoneDisplay: string | null;
  direction: CallDirection;
  category: CallCategory;
  status: string;
  reason: string | null;
  dialedAt: Date | null;
  connectedAt: Date | null;
  endedAt: Date | null;
  durationSec: number | null;
  noteDraft: string | null;
  resultGroup: string | null;
  crmPhonecallId: string | null;
  handledAt: Date | null;
  createdAt: Date;
}

export interface PhoneAssignment {
  phoneE164: string;
  leadId: string;
  leadName: string | null;
  companyName: string | null;
}

export interface HistoryFilter {
  categories?: CallCategory[];
  /** Zurich calendar day `YYYY-MM-DD`. */
  day?: string;
  resultCodes?: number[];
  search?: string;
  onlyOpen?: boolean;
}

/** One line, no line breaks, max. `max` characters (note preview «Notiz in einer Zeile»). */
export function oneLine(text: string | null | undefined, max = 160): string | null {
  if (!text) return null;
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * Category of a portal session. An «unbekannte Nummer» that was assigned to a lead afterwards becomes a callback:
 * answered if the call was connected, otherwise missed (so it is highlighted until Markus calls back).
 */
export function categorizeSession(session: Pick<HistorySession, 'category' | 'leadId' | 'connectedAt'>, assignment: PhoneAssignment | null): CallCategory {
  if (session.category === 'unknown_number' && !session.leadId && assignment) {
    return session.connectedAt ? 'callback_answered' : 'callback_missed';
  }
  return session.category;
}

export function categorizeCrmCall(call: Pick<PhoneCall, 'direction'>, session: Pick<HistorySession, 'category'> | null): CallCategory {
  if (session) return session.category;
  return call.direction === 'incoming' ? 'callback_answered' : 'outbound';
}

interface OutboundMark {
  at: number;
  leadId: string | null;
  e164: string | null;
  resultCode: number | null;
}

/**
 * A missed callback stays open until it is marked done (`handledAt`) or Markus called the person back afterwards
 * (outgoing call to the same lead or the same number).
 */
export function isMissedOpen(
  entry: { at: number; category: CallCategory; leadId: string | null; e164: string | null; handled: boolean },
  outbound: OutboundMark[],
): boolean {
  if (entry.category !== 'callback_missed' || entry.handled) return false;
  return !outbound.some((o) => o.at > entry.at && ((entry.leadId && o.leadId === entry.leadId) || (entry.e164 && o.e164 === entry.e164)));
}

const sessionAt = (s: HistorySession) => (s.dialedAt ?? s.connectedAt ?? s.createdAt).getTime();

export function resultCodeOf(resultGroup: string | null): number | null {
  if (!resultGroup) return null;
  return RESULT_GROUP_CODES[resultGroup as ResultGroupKey] ?? null;
}

/** Merge CRM calls and portal sessions into history rows (newest first, unfiltered). */
export function buildHistory(calls: PhoneCall[], sessions: HistorySession[], assignments: PhoneAssignment[]): HistoryRow[] {
  const sessionByPhonecall = new Map<string, HistorySession>();
  for (const s of sessions) if (s.crmPhonecallId) sessionByPhonecall.set(s.crmPhonecallId, s);
  const assignmentByPhone = new Map(assignments.map((a) => [a.phoneE164, a]));
  const crmIds = new Set(calls.map((c) => c.id));

  const outbound: OutboundMark[] = [];
  for (const c of calls) {
    if (c.direction === 'outgoing') outbound.push({ at: Date.parse(c.start), leadId: c.leadId, e164: c.phoneE164, resultCode: c.resultCode });
  }
  for (const s of sessions) {
    if (s.direction === 'outbound' && s.status !== 'abandoned' && !(s.crmPhonecallId && crmIds.has(s.crmPhonecallId))) {
      outbound.push({ at: sessionAt(s), leadId: s.leadId, e164: s.phoneE164, resultCode: resultCodeOf(s.resultGroup) });
    }
  }
  outbound.sort((a, b) => b.at - a.at);
  const lastOutboundBefore = (leadId: string | null, at: number) => {
    if (!leadId) return null;
    const o = outbound.find((x) => x.leadId === leadId && x.at < at);
    return o ? { at: new Date(o.at).toISOString(), resultCode: o.resultCode } : null;
  };

  const rows: HistoryRow[] = [];
  for (const c of calls) {
    const session = sessionByPhonecall.get(c.id) ?? null;
    const category = categorizeCrmCall(c, session);
    const at = Date.parse(c.start);
    const direction: CallDirection = c.direction === 'incoming' ? 'inbound' : 'outbound';
    const e164 = c.phoneE164 ?? session?.phoneE164 ?? null;
    const handled = !!session?.handledAt;
    rows.push({
      id: `pc:${c.id}`,
      at: c.start,
      category,
      direction,
      personName: c.leadName ?? session?.leadName ?? null,
      companyName: c.companyName ?? session?.companyName ?? null,
      leadId: c.leadId ?? session?.leadId ?? null,
      phoneDisplay: (e164 ? formatPhoneDisplay(e164) : null) ?? c.phoneNumber,
      phoneE164: e164,
      resultCode: c.resultCode ?? resultCodeOf(session?.resultGroup ?? null),
      notePreview: oneLine(c.text ?? session?.noteDraft),
      durationSec: c.durationSec ?? session?.durationSec ?? null,
      open: isMissedOpen({ at, category, leadId: c.leadId, e164, handled }, outbound),
      lastOutbound: direction === 'inbound' ? lastOutboundBefore(c.leadId, at) : null,
      sessionId: session?.id ?? null,
      subject: c.subject,
      assignable: false,
      handled,
    });
  }
  for (const s of sessions) {
    if (s.crmPhonecallId && crmIds.has(s.crmPhonecallId)) continue;
    // Discarded outbound attempts are no calls; missed / unknown inbound calls always count.
    if (s.status === 'abandoned' && s.direction === 'outbound') continue;
    const assignment = !s.leadId && s.phoneE164 ? (assignmentByPhone.get(s.phoneE164) ?? null) : null;
    const category = categorizeSession(s, assignment);
    const at = sessionAt(s);
    const leadId = s.leadId ?? assignment?.leadId ?? null;
    const handled = !!s.handledAt;
    rows.push({
      id: `cs:${s.id}`,
      at: new Date(at).toISOString(),
      category,
      direction: s.direction,
      personName: s.leadName ?? assignment?.leadName ?? null,
      companyName: s.companyName ?? assignment?.companyName ?? null,
      leadId,
      phoneDisplay: (s.phoneE164 ? formatPhoneDisplay(s.phoneE164) : null) ?? s.phoneDisplay,
      phoneE164: s.phoneE164,
      resultCode: resultCodeOf(s.resultGroup),
      notePreview: oneLine(s.noteDraft),
      durationSec: s.durationSec,
      open: isMissedOpen({ at, category, leadId, e164: s.phoneE164, handled }, outbound),
      lastOutbound: s.direction === 'inbound' ? lastOutboundBefore(leadId, at) : null,
      sessionId: s.id,
      subject: s.reason,
      assignable: category === 'unknown_number' && !leadId,
      handled,
    });
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

/** Search in name, company and number (any format: «061 555 01 02», «+41615550102», «5550102»). */
export function matchesSearch(row: Pick<HistoryRow, 'personName' | 'companyName' | 'phoneE164' | 'phoneDisplay'>, search: string): boolean {
  const q = search.trim();
  if (!q) return true;
  const lower = q.toLocaleLowerCase('de-CH');
  const text = `${row.personName ?? ''} ${row.companyName ?? ''}`.toLocaleLowerCase('de-CH');
  if (text.includes(lower)) return true;
  const digits = phoneDigits(q);
  if (digits.length < 3 || /[a-zäöü]/i.test(q)) return false;
  if (!row.phoneE164) return phoneDigits(row.phoneDisplay).includes(digits);
  const normalized = normalizePhone(q);
  if (normalized.status === 'ok' && normalized.e164) return normalized.e164 === row.phoneE164;
  return nationalDigits(row.phoneE164).includes(digits.replace(/^0+/, '')) || phoneDigits(row.phoneE164).includes(digits);
}

export function filterHistory(rows: HistoryRow[], filter: HistoryFilter): { items: HistoryRow[]; counts: Record<CallCategory, number>; openMissed: number } {
  const base = rows.filter((r) => {
    if (filter.day && zurichDate(r.at) !== filter.day) return false;
    if (filter.resultCodes?.length && (r.resultCode == null || !filter.resultCodes.includes(r.resultCode))) return false;
    if (filter.search && !matchesSearch(r, filter.search)) return false;
    if (filter.onlyOpen && !r.open && !(r.assignable && !r.handled)) return false;
    return true;
  });
  const counts = Object.fromEntries(CALL_CATEGORIES.map((c) => [c, 0])) as Record<CallCategory, number>;
  for (const r of base) counts[r.category] += 1;
  const items = filter.categories?.length ? base.filter((r) => filter.categories!.includes(r.category)) : base;
  return { items, counts, openMissed: rows.filter((r) => r.open).length };
}
