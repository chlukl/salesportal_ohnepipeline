/**
 * Briefing for first meetings (INTENT 6.10, 6.17).
 *
 * Built per booking for the booked sales + Nico (stored as `analyses` row kind `briefing`, one per booking).
 * Delivery:
 *   - «Vorbereitung nötig» → mail to both 1 week before the meeting (immediately when closer) – job `ai.briefing_mail`
 *   - otherwise → calendar entry on the meeting time in the sales' and Nico's calendars: category «Kallysoft Briefing»,
 *     show-as free, subject without «Vorstellung der Kallysoft», linked via KlsTerminId.
 *
 * Service functions for the scheduling module (delta job): `updateBriefingForBooking` (moved → entries move + briefing
 * rebuilt) and `deleteBriefingForBooking` (cancelled → entries deleted, pending mail cancelled).
 * Briefing status (offen / gelesen / Vorbereitung erledigt) lives in `bookings.briefing_status` (Pendenzen).
 */
import {
  formatZurich,
  useCaseLabel,
  type Booking,
  type BriefingStatus,
  type Briefing,
  type CampaignMail,
  type CalendarEventInput,
} from '@sales-portal/shared';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { RequestAuth } from '../../auth/rbac';
import { analyses, bookings, callSessions, jobs, templates } from '../../db/schema';
import { enqueueJob } from '../../jobs/queue';
import { audit } from '../../lib/audit';
import { getSetting } from '../../lib/settings';
import { JOB_BUILD_BRIEFING, toAnalysis } from './analysis';
import { budgetStatus } from './budget';
import {
  assertCanUpdateBriefing,
  assertCanViewBriefing,
  canUpdateBriefingStatus,
  loadAiContext,
  loadBooking,
  loadUsers,
  toBooking,
  type AiDeps,
  type BookingRow,
} from './common';

export { JOB_BUILD_BRIEFING };
export const JOB_DELIVER_BRIEFING = 'ai.deliver_briefing';
export const JOB_BRIEFING_MAIL = 'ai.briefing_mail';

const ACTIVE: Booking['status'][] = ['booked', 'rescheduled'];
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------------------------------
// Rendering (pure)
// ---------------------------------------------------------------------------------------------------------------------

const DEFAULT_SUBJECT = 'Briefing: {Firma} – {Datum} {Uhrzeit}';

/** Briefing subject: never contains «Vorstellung der Kallysoft …» (INTENT 6.10). */
export function renderBriefingSubject(template: string | null, booking: Pick<Booking, 'companyName' | 'start'>): string {
  const subject = (template || DEFAULT_SUBJECT)
    .replaceAll('{Firma}', booking.companyName ?? 'Erstgespräch')
    .replaceAll('{Datum}', formatZurich(booking.start, 'dd.MM.yyyy'))
    .replaceAll('{Uhrzeit}', formatZurich(booking.start, 'HH:mm'))
    .replace(/Vorstellung der Kallysoft.*?(\s[–\-|]\s+|$)/gi, '')
    .trim();
  return subject.slice(0, 250) || 'Briefing';
}

const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '–');

/** Plain-text briefing for calendar body and mail (template placeholders from the admin template `briefing.default`). */
export function renderBriefingText(briefing: Briefing, template: string | null): string {
  const values: Record<string, string> = {
    Kampagne: briefing.campaignContext ? `AUS DER KAMPAGNE\n${briefing.campaignContext}\n` : '',
    Profil: `${briefing.company} – ${briefing.profile}`,
    Kontakt: briefing.contact,
    Verlauf: briefing.history,
    UseCases: briefing.useCases.length ? `\n${list(briefing.useCases.map((u) => `${useCaseLabel(u.id)}: ${u.why}`))}` : '–',
    Fragen: `\n${list(briefing.openingQuestions)}`,
    OffenePunkte: `\n${list(briefing.openPoints)}`,
    Vorbereitung: `\n${list(briefing.preparation)}`,
  };
  const body = (template ?? '{Kampagne}\nFirma: {Profil}\nAnsprechperson: {Kontakt}\nVerlauf: {Verlauf}\nUse Cases: {UseCases}\nEinstiegsfragen: {Fragen}\nOffene Punkte: {OffenePunkte}\nVorbereiten: {Vorbereitung}').replace(
    /\{(\w+)\}/g,
    (m, key: string) => values[key] ?? m,
  );
  return `${body.trim()}\n\n(Erstellt vom Sales-Portal – KI-Vorschlag, bitte kritisch lesen.)`;
}

/** When the preparation mail is due: 1 week (setting) before the meeting, immediately if that is in the past. */
export function briefingMailDueAt(start: Date, now: Date, daysBefore: number): Date {
  const due = new Date(start.getTime() - daysBefore * DAY_MS);
  return due < now ? now : due;
}

// ---------------------------------------------------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------------------------------------------------

async function briefingRow(deps: AiDeps, bookingId: string) {
  const [row] = await deps.db
    .select()
    .from(analyses)
    .where(and(eq(analyses.kind, 'briefing'), eq(analyses.bookingId, bookingId)))
    .orderBy(desc(analyses.createdAt))
    .limit(1);
  return row ?? null;
}

async function briefingTemplate(deps: AiDeps): Promise<{ subject: string | null; body: string | null }> {
  const [t] = await deps.db.select().from(templates).where(eq(templates.key, 'briefing.default'));
  return { subject: t?.subject ?? null, body: t?.body ?? null };
}

async function recipients(deps: AiDeps, b: BookingRow): Promise<{ sales: { email: string; name: string } | null; specialist: { email: string; name: string } | null }> {
  const rules = await getSetting(deps.db, 'booking.rules');
  const users = await loadUsers(deps.db, [b.salesUserId, b.specialistUserId]);
  const sales = b.salesUserId ? users.get(b.salesUserId) : undefined;
  const spec = b.specialistUserId ? users.get(b.specialistUserId) : undefined;
  return {
    sales: sales ? { email: sales.email, name: sales.displayName } : rules.defaultSalesEmail ? { email: rules.defaultSalesEmail, name: 'Sales' } : null,
    specialist: spec ? { email: spec.email, name: spec.displayName } : rules.specialistEmail ? { email: rules.specialistEmail, name: 'KI-Spezialist' } : null,
  };
}

async function cancelPendingMail(deps: AiDeps, bookingId: string): Promise<void> {
  await deps.db.delete(jobs).where(and(eq(jobs.type, JOB_BRIEFING_MAIL), eq(jobs.status, 'queued'), eq(jobs.dedupeKey, `${JOB_BRIEFING_MAIL}:${bookingId}`)));
}

/** Start building the briefing for a (new) booking. Called by the scheduling module after booking; also by the sweep. */
export async function onBookingCreated(deps: Pick<AiDeps, 'db'>, bookingId: string): Promise<void> {
  await enqueueJob(deps.db, JOB_BUILD_BRIEFING, { bookingId }, { dedupeKey: `${JOB_BUILD_BRIEFING}:${bookingId}`, maxAttempts: 3 });
}

// ---------------------------------------------------------------------------------------------------------------------
// Build + deliver
// ---------------------------------------------------------------------------------------------------------------------

/** Job `ai.build_briefing`: (re)generate the briefing, then deliver it. */
export async function buildBriefingJob(deps: AiDeps, bookingId: string): Promise<'built' | 'skipped'> {
  const b = await loadBooking(deps.db, bookingId).catch(() => null);
  if (!b || !ACTIVE.includes(b.status)) return 'skipped';
  const budget = await budgetStatus(deps.db, deps.now());
  if (budget.exceeded) {
    deps.log.warn({ bookingId }, 'briefing not built: monthly AI budget exceeded');
    return 'skipped';
  }
  const [call] = b.callSessionId ? await deps.db.select().from(callSessions).where(eq(callSessions.id, b.callSessionId)) : [];
  const ctx = await loadAiContext(deps, b.leadId, { note: call?.noteDraft ?? null, transcript: null });
  const r = await recipients(deps, b);
  const out = await deps.adapters.ai.buildBriefing({
    ...ctx,
    booking: toBooking(b),
    salesName: r.sales?.name ?? 'Sales',
    specialistName: r.specialist?.name ?? 'KI-Spezialist',
  });
  const existing = await briefingRow(deps, bookingId);
  const now = deps.now();
  if (existing) {
    // Re-generations accumulate their usage on the same row so the cost keeps counting for the cap.
    const prev = existing.usage;
    const usage = out.usage
      ? {
          inputTokens: (prev?.inputTokens ?? 0) + out.usage.inputTokens,
          outputTokens: (prev?.outputTokens ?? 0) + out.usage.outputTokens,
          costUsd: (prev?.costUsd ?? 0) + (out.usage.costUsd ?? 0),
        }
      : prev;
    await deps.db
      .update(analyses)
      .set({ result: out.result, model: out.model, usage, status: 'ready', error: null, updatedAt: now })
      .where(eq(analyses.id, existing.id));
  } else {
    await deps.db.insert(analyses).values({ kind: 'briefing', leadId: b.leadId, bookingId, status: 'ready', model: out.model, result: out.result, usage: out.usage });
  }
  await enqueueJob(deps.db, JOB_DELIVER_BRIEFING, { bookingId }, { dedupeKey: `${JOB_DELIVER_BRIEFING}:${bookingId}`, maxAttempts: 5 });
  return 'built';
}

/** Find which of the two mailboxes holds each stored briefing event id. */
async function locateEvents(deps: AiDeps, ids: string[], mailboxes: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of ids) {
    for (const mb of mailboxes) {
      const ev = await deps.adapters.calendar.getEvent(mb, id).catch(() => null);
      if (ev) {
        out.set(mb, id);
        break;
      }
    }
  }
  return out;
}

async function deleteEvents(deps: AiDeps, b: BookingRow): Promise<number> {
  if (!b.briefingEventIds.length) return 0;
  const r = await recipients(deps, b);
  const mailboxes = [r.sales?.email, r.specialist?.email].filter((x): x is string => !!x);
  const located = await locateEvents(deps, b.briefingEventIds, mailboxes);
  for (const [mb, id] of located) await deps.adapters.calendar.deleteEvent(mb, id).catch(() => undefined);
  await deps.db.update(bookings).set({ briefingEventIds: [], updatedAt: deps.now() }).where(eq(bookings.id, b.id));
  return located.size;
}

/** Job `ai.deliver_briefing`: calendar entries (no preparation) or scheduled mail (preparation needed). Idempotent. */
export async function deliverBriefingJob(deps: AiDeps, bookingId: string): Promise<'calendar' | 'mail_scheduled' | 'mail_sent_already' | 'skipped'> {
  const b = await loadBooking(deps.db, bookingId).catch(() => null);
  if (!b) return 'skipped';
  if (!ACTIVE.includes(b.status)) {
    await deleteBriefingForBooking(deps, bookingId);
    return 'skipped';
  }
  const briefing = await briefingRow(deps, bookingId);
  if (!briefing?.result) return 'skipped';
  const rules = await getSetting(deps.db, 'booking.rules');
  const now = deps.now();

  if (b.needsPreparation) {
    // Mail instead of calendar entries.
    await deleteEvents(deps, b);
    if (b.briefingMailSentAt) return 'mail_sent_already';
    await cancelPendingMail(deps, bookingId);
    await enqueueJob(
      deps.db,
      JOB_BRIEFING_MAIL,
      { bookingId },
      { runAt: briefingMailDueAt(b.startAt, now, rules.briefingMailDaysBefore), dedupeKey: `${JOB_BRIEFING_MAIL}:${bookingId}`, maxAttempts: 5 },
    );
    return 'mail_scheduled';
  }

  await cancelPendingMail(deps, bookingId);
  const tpl = await briefingTemplate(deps);
  const booking = toBooking(b);
  const r = await recipients(deps, b);
  const mailboxes = [r.sales?.email, r.specialist?.email].filter((x): x is string => !!x);
  const located = await locateEvents(deps, b.briefingEventIds, mailboxes);
  const input = (mailbox: string): CalendarEventInput => ({
    mailbox,
    subject: renderBriefingSubject(tpl.subject, booking),
    body: renderBriefingText(briefing.result as Briefing, tpl.body),
    start: booking.start,
    end: booking.end,
    showAs: 'free',
    categories: [rules.briefingCategory],
    attendees: [],
    extendedProperties: { KlsTerminId: b.bookingRef, KlsRolle: 'briefing' },
    isOnlineMeeting: false,
  });
  const ids: string[] = [];
  for (const mb of mailboxes) {
    const existing = located.get(mb);
    if (existing) {
      const { mailbox: _m, ...patch } = input(mb);
      await deps.adapters.calendar.updateEvent(mb, existing, patch);
      ids.push(existing);
    } else {
      const ev = await deps.adapters.calendar.createEvent(input(mb));
      ids.push(ev.id);
    }
  }
  await deps.db.update(bookings).set({ briefingEventIds: ids, updatedAt: now }).where(eq(bookings.id, b.id));
  await audit(deps.db, { actor: 'system', action: 'calendar.briefing_entries', entity: 'booking', entityId: b.id, meta: { entries: ids.length } });
  return 'calendar';
}

/** Job `ai.briefing_mail`: preparation mail to sales + Nico (from the coldcaller who booked). */
export async function briefingMailJob(deps: AiDeps, bookingId: string): Promise<'sent' | 'rescheduled' | 'skipped'> {
  const b = await loadBooking(deps.db, bookingId).catch(() => null);
  if (!b || !ACTIVE.includes(b.status) || !b.needsPreparation || b.briefingMailSentAt) return 'skipped';
  const briefing = await briefingRow(deps, bookingId);
  if (!briefing?.result) return 'skipped';
  const rules = await getSetting(deps.db, 'booking.rules');
  const now = deps.now();
  const due = briefingMailDueAt(b.startAt, now, rules.briefingMailDaysBefore);
  if (due.getTime() - now.getTime() > 60_000) {
    // Meeting was moved later since scheduling → wait.
    await enqueueJob(deps.db, JOB_BRIEFING_MAIL, { bookingId }, { runAt: due });
    return 'rescheduled';
  }
  const r = await recipients(deps, b);
  const to = [r.sales?.email, r.specialist?.email].filter((x): x is string => !!x);
  if (!to.length) return 'skipped';
  const sender = (await loadUsers(deps.db, [b.createdBy])).get(b.createdBy);
  const tpl = await briefingTemplate(deps);
  const booking = toBooking(b);
  const body = [
    `Vorbereitung nötig für das Erstgespräch am ${formatZurich(b.startAt, 'dd.MM.yyyy')} um ${formatZurich(b.startAt, 'HH:mm')} Uhr.`,
    b.preparationNote ? `Was vorzubereiten ist: ${b.preparationNote}` : null,
    '',
    renderBriefingText(briefing.result as Briefing, tpl.body),
  ]
    .filter((x): x is string => x !== null)
    .join('\n');
  await deps.adapters.mail.send(
    { userId: sender?.id ?? null, email: sender?.email ?? to[0], displayName: sender?.displayName ?? 'Sales-Portal' },
    { to, subject: `Vorbereitung: ${renderBriefingSubject(tpl.subject, booking)}`, body, relatedLeadId: b.leadId },
  );
  await deps.db.update(bookings).set({ briefingMailSentAt: now, updatedAt: now }).where(eq(bookings.id, b.id));
  await audit(deps.db, { actor: 'system', action: 'mail.briefing_sent', entity: 'booking', entityId: b.id, meta: { recipients: to.length } });
  return 'sent';
}

// ---------------------------------------------------------------------------------------------------------------------
// Service functions for the scheduling module (delta job)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Booking was moved (or its preparation flag changed): move/refresh the briefing entries now with the current briefing
 * and rebuild the briefing in the background (it is delivered again afterwards). Call after updating `bookings`.
 */
export async function updateBriefingForBooking(deps: AiDeps, bookingId: string): Promise<void> {
  const b = await loadBooking(deps.db, bookingId);
  if (!ACTIVE.includes(b.status)) {
    await deleteBriefingForBooking(deps, bookingId);
    return;
  }
  if (await briefingRow(deps, bookingId)) await deliverBriefingJob(deps, bookingId);
  await onBookingCreated(deps, bookingId);
}

/** Booking was cancelled: delete the briefing calendar entries and any pending preparation mail. */
export async function deleteBriefingForBooking(deps: AiDeps, bookingId: string): Promise<void> {
  const b = await loadBooking(deps.db, bookingId).catch(() => null);
  if (!b) return;
  const removed = await deleteEvents(deps, b);
  await cancelPendingMail(deps, bookingId);
  await deps.db
    .delete(jobs)
    .where(and(eq(jobs.status, 'queued'), inArray(jobs.dedupeKey, [`${JOB_BUILD_BRIEFING}:${bookingId}`, `${JOB_DELIVER_BRIEFING}:${bookingId}`])));
  if (removed) await audit(deps.db, { actor: 'system', action: 'calendar.briefing_entries_deleted', entity: 'booking', entityId: bookingId, meta: { entries: removed } });
}

/** Recurring safety net: active future bookings without a briefing get one. */
export async function sweepBookingsWithoutBriefing(deps: AiDeps): Promise<number> {
  const upcoming = await deps.db
    .select({ id: bookings.id, startAt: bookings.startAt })
    .from(bookings)
    .where(and(inArray(bookings.status, ACTIVE), isNotNull(bookings.startAt)))
    .limit(500);
  const future = upcoming.filter((b) => b.startAt > deps.now());
  if (!future.length) return 0;
  const done = await deps.db
    .select({ bookingId: analyses.bookingId })
    .from(analyses)
    .where(and(eq(analyses.kind, 'briefing'), inArray(analyses.bookingId, future.map((b) => b.id))));
  const have = new Set(done.map((d) => d.bookingId));
  const missing = future.filter((b) => !have.has(b.id)).slice(0, 20);
  for (const b of missing) await onBookingCreated(deps, b.id);
  return missing.length;
}

// ---------------------------------------------------------------------------------------------------------------------
// View + status (routes)
// ---------------------------------------------------------------------------------------------------------------------

export interface BriefingView {
  booking: Pick<Booking, 'id' | 'leadId' | 'leadName' | 'companyName' | 'start' | 'end' | 'status' | 'origin' | 'needsPreparation' | 'preparationNote' | 'briefingStatus'>;
  briefing: Briefing | null;
  generatedAt: string | null;
  analysisId: string | null;
  campaignMails: CampaignMail[];
  delivery: { mode: 'mail' | 'calendar'; mailDueAt: string | null; mailSentAt: string | null; calendarEntries: number };
  participants: { sales: string | null; specialist: string | null };
  canUpdateStatus: boolean;
}

export async function getBriefingView(deps: AiDeps, auth: RequestAuth, bookingId: string): Promise<BriefingView> {
  const b = await loadBooking(deps.db, bookingId);
  assertCanViewBriefing(auth, b);
  const row = await briefingRow(deps, bookingId);
  const rules = await getSetting(deps.db, 'booking.rules');
  const r = await recipients(deps, b);
  const campaignMails = b.origin === 'campaign' || (row?.result as Briefing | undefined)?.campaignContext ? await deps.adapters.crm.listCampaignMails(b.leadId).catch(() => []) : [];
  const booking = toBooking(b);
  return {
    booking: {
      id: booking.id,
      leadId: booking.leadId,
      leadName: booking.leadName,
      companyName: booking.companyName,
      start: booking.start,
      end: booking.end,
      status: booking.status,
      origin: booking.origin,
      needsPreparation: booking.needsPreparation,
      preparationNote: booking.preparationNote,
      briefingStatus: booking.briefingStatus,
    },
    briefing: (row?.result as Briefing | null) ?? null,
    generatedAt: row ? row.updatedAt.toISOString() : null,
    analysisId: row ? toAnalysis(row).id : null,
    campaignMails,
    delivery: {
      mode: b.needsPreparation ? 'mail' : 'calendar',
      mailDueAt: b.needsPreparation ? briefingMailDueAt(b.startAt, deps.now(), rules.briefingMailDaysBefore).toISOString() : null,
      mailSentAt: b.briefingMailSentAt?.toISOString() ?? null,
      calendarEntries: b.briefingEventIds.length,
    },
    participants: { sales: r.sales?.name ?? null, specialist: r.specialist?.name ?? null },
    canUpdateStatus: canUpdateBriefingStatus(auth, b),
  };
}

export async function setBriefingStatus(deps: AiDeps, auth: RequestAuth, bookingId: string, status: BriefingStatus): Promise<BriefingStatus> {
  const b = await loadBooking(deps.db, bookingId);
  assertCanUpdateBriefing(auth, b);
  // «gelesen» never downgrades «Vorbereitung erledigt».
  if (status === 'read' && b.briefingStatus === 'prepared') return b.briefingStatus;
  if (status === b.briefingStatus) return status;
  await deps.db.update(bookings).set({ briefingStatus: status, updatedAt: deps.now() }).where(eq(bookings.id, bookingId));
  await audit(deps.db, { actor: auth.actor, action: 'briefing.status', entity: 'booking', entityId: bookingId, field: 'briefingStatus', oldValue: b.briefingStatus, newValue: status });
  return status;
}

export async function requestBriefingRebuild(deps: AiDeps, auth: RequestAuth, bookingId: string): Promise<void> {
  const b = await loadBooking(deps.db, bookingId);
  assertCanViewBriefing(auth, b);
  if (!ACTIVE.includes(b.status)) return;
  await onBookingCreated(deps, bookingId);
  await audit(deps.db, { actor: auth.actor, action: 'ai.briefing_rebuild', entity: 'booking', entityId: bookingId });
}
