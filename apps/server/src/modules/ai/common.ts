/** Shared helpers of the ai module: dependencies, actors, row mappers, AI context loading, object-level access. */
import type { Actor, AiCallContext, Booking, ResultGroupRule } from '@sales-portal/shared';
import { eq, inArray, type InferSelectModel } from 'drizzle-orm';
import type { RequestAuth } from '../../auth/rbac';
import type { AppConfig } from '../../config';
import type { Db } from '../../db/client';
import { bookings, resultGroupRules, users } from '../../db/schema';
import type { Adapters } from '../../integrations';
import { forbidden, notFound } from '../../lib/errors';
import type { Logger } from '../../lib/logger';

/** Everything a service function of this module needs (routes build it per request, jobs from the job context). */
export interface AiDeps {
  config: AppConfig;
  db: Db;
  adapters: Adapters;
  log: Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>;
  now: () => Date;
}

export const SYSTEM_ACTOR: Actor = { kind: 'system', userId: null, displayName: 'Sales-Portal', crmUserId: null, email: null };

export type BookingRow = InferSelectModel<typeof bookings>;

export function toBooking(r: BookingRow): Booking {
  return {
    id: r.id,
    bookingRef: r.bookingRef,
    leadId: r.leadId,
    leadName: r.leadName,
    companyName: r.companyName,
    callSessionId: r.callSessionId,
    salesUserId: r.salesUserId,
    specialistUserId: r.specialistUserId,
    extraCall: r.extraCall,
    start: r.startAt.toISOString(),
    end: r.endAt.toISOString(),
    status: r.status,
    origin: r.origin,
    eventId: r.eventId,
    iCalUId: r.iCalUId,
    blockerEventIds: r.blockerEventIds,
    briefingEventIds: r.briefingEventIds,
    needsPreparation: r.needsPreparation,
    preparationNote: r.preparationNote,
    briefingStatus: r.briefingStatus,
    externalAttendees: r.externalAttendees,
    subject: r.subject,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function loadBooking(db: Db, bookingId: string): Promise<BookingRow> {
  const [row] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!row) throw notFound('Termin nicht gefunden');
  return row;
}

export interface PortalUserLite {
  id: string;
  email: string;
  displayName: string;
}

export async function loadUsers(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, PortalUserLite>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map();
  const rows = await db.select({ id: users.id, email: users.email, displayName: users.displayName }).from(users).where(inArray(users.id, wanted));
  return new Map(rows.map((r) => [r.id, r]));
}

export function actorOf(auth: RequestAuth): Actor {
  return auth.actor;
}

export const isAdmin = (auth: Pick<RequestAuth, 'effectiveRoles'>) => auth.effectiveRoles.includes('admin');

/** Owner-or-admin check for per-user objects (analyses, mail drafts). */
export function assertOwnerOrAdmin(auth: RequestAuth, ownerUserId: string | null): void {
  if (ownerUserId === auth.user.id) return;
  if (isAdmin(auth)) return;
  throw notFound('Nicht gefunden');
}

/**
 * Who may see a booking's briefing (INTENT 3, 6.10): admin; AI specialist (Nico sees all first meetings);
 * the booked sales; the specialist of the booking; the coldcaller who booked it.
 */
export function canViewBriefing(auth: RequestAuth, b: Pick<BookingRow, 'salesUserId' | 'specialistUserId' | 'createdBy'>): boolean {
  const roles = auth.effectiveRoles;
  const me = auth.user.id;
  if (roles.includes('admin') || roles.includes('ai_specialist')) return true;
  if (roles.includes('sales') && (b.salesUserId === me || b.specialistUserId === me)) return true;
  if (roles.includes('coldcaller') && b.createdBy === me) return true;
  return false;
}

/** Status changes (gelesen / Vorbereitung erledigt) only by the recipients, the AI specialist role or admin. */
export function canUpdateBriefingStatus(auth: RequestAuth, b: Pick<BookingRow, 'salesUserId' | 'specialistUserId'>): boolean {
  const roles = auth.effectiveRoles;
  const me = auth.user.id;
  if (roles.includes('admin') || roles.includes('ai_specialist')) return true;
  return roles.includes('sales') && (b.salesUserId === me || b.specialistUserId === me);
}

export function assertCanViewBriefing(auth: RequestAuth, b: BookingRow): void {
  if (!canViewBriefing(auth, b)) throw notFound('Termin nicht gefunden');
}

export function assertCanUpdateBriefing(auth: RequestAuth, b: BookingRow): void {
  if (!canViewBriefing(auth, b)) throw notFound('Termin nicht gefunden');
  if (!canUpdateBriefingStatus(auth, b)) throw forbidden('Nur die Teilnehmenden können das Briefing abhaken');
}

export async function activeResultGroups(db: Db): Promise<Pick<ResultGroupRule, 'key' | 'label'>[]> {
  const rows = await db.select().from(resultGroupRules).where(eq(resultGroupRules.isActive, true));
  return rows.sort((a, b) => a.sortOrder - b.sortOrder).map((r) => ({ key: r.definition.key, label: r.label }));
}

export async function activeRuleDefinitions(db: Db): Promise<Map<string, ResultGroupRule>> {
  const rows = await db.select().from(resultGroupRules).where(eq(resultGroupRules.isActive, true));
  return new Map(rows.map((r) => [r.key, r.definition]));
}

/** Load lead + persons + timeline + campaign mails for an AI call. */
export async function loadAiContext(
  deps: AiDeps,
  leadId: string,
  extra: Pick<AiCallContext, 'note' | 'transcript'>,
): Promise<AiCallContext> {
  const crm = deps.adapters.crm;
  const lead = await crm.getLead(leadId);
  if (!lead) throw notFound('Lead nicht gefunden');
  const [persons, timeline, campaignMails, resultGroups] = await Promise.all([
    crm.getCompanyPersons(leadId),
    crm.getTimeline(leadId, { limit: 40 }),
    crm.listCampaignMails(leadId),
    activeResultGroups(deps.db),
  ]);
  return { lead, persons, timeline, campaignMails, note: extra.note, transcript: extra.transcript, resultGroups };
}
