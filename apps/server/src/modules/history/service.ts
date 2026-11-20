/**
 * Anrufhistorie + Rückruf-Suche (INTENT 6.15, 6.18).
 * Sources: CRM phone calls of the user (adapter) + portal `call_sessions` (missed callbacks, unknown numbers, calls
 * without CRM entry yet). Writes only `call_sessions.handled_at` (missed callback done) and `phone_assignments`.
 */
import {
  normalizePhone,
  nationalDigits,
  phoneDigits,
  type CallbackHit,
  type CallbackSearchResponse,
  type HistoryResponse,
  type PhoneCall,
} from '@sales-portal/shared';
import { and, eq, gte, inArray, isNull } from 'drizzle-orm';
import type { RequestAuth } from '../../auth/rbac';
import type { Db } from '../../db/client';
import { callSessions, phoneAssignments } from '../../db/schema';
import type { Adapters } from '../../integrations';
import { audit } from '../../lib/audit';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { canViewOthers, resolveTarget } from '../pendenzen/service';
import { buildHistory, filterHistory, type HistoryFilter, type HistorySession, type PhoneAssignment } from './rules';

const DAY_MS = 86_400_000;

async function loadAssignments(db: Db): Promise<PhoneAssignment[]> {
  return db
    .select({ phoneE164: phoneAssignments.phoneE164, leadId: phoneAssignments.leadId, leadName: phoneAssignments.leadName, companyName: phoneAssignments.companyName })
    .from(phoneAssignments);
}

async function loadSessions(db: Db, userId: string, since: Date): Promise<HistorySession[]> {
  return db
    .select({
      id: callSessions.id,
      leadId: callSessions.leadId,
      leadName: callSessions.leadName,
      companyName: callSessions.companyName,
      phoneE164: callSessions.phoneE164,
      phoneDisplay: callSessions.phoneDisplay,
      direction: callSessions.direction,
      category: callSessions.category,
      status: callSessions.status,
      reason: callSessions.reason,
      dialedAt: callSessions.dialedAt,
      connectedAt: callSessions.connectedAt,
      endedAt: callSessions.endedAt,
      durationSec: callSessions.durationSec,
      noteDraft: callSessions.noteDraft,
      resultGroup: callSessions.resultGroup,
      crmPhonecallId: callSessions.crmPhonecallId,
      handledAt: callSessions.handledAt,
      createdAt: callSessions.createdAt,
    })
    .from(callSessions)
    .where(and(eq(callSessions.userId, userId), gte(callSessions.createdAt, since)));
}

export async function listHistory(
  db: Db,
  adapters: Adapters,
  auth: RequestAuth,
  filter: HistoryFilter & { userId?: string; limit?: number; days?: number },
  now: Date,
): Promise<HistoryResponse & { warnings: string[] }> {
  const person = await resolveTarget(db, auth, filter.userId);
  const since = new Date(now.getTime() - (filter.days ?? 90) * DAY_MS);
  const warnings: string[] = [];
  let calls: PhoneCall[] = [];
  if (person.crmUserId) {
    try {
      calls = await adapters.crm.listPhoneCalls({ ownerId: person.crmUserId, from: since.toISOString(), limit: 2000 });
    } catch {
      warnings.push('Telefonaktivitäten aus dem CRM konnten gerade nicht geladen werden – es fehlen ältere Anrufe.');
    }
  }
  const [sessions, assignments] = await Promise.all([loadSessions(db, person.id, since), loadAssignments(db)]);
  const rows = buildHistory(calls, sessions, assignments);
  const { items, counts, openMissed } = filterHistory(rows, filter);
  return { items: items.slice(0, filter.limit ?? 300), counts, openMissed, total: items.length, warnings };
}

/** Header counter «verpasste Rückrufe»: open missed callbacks of the current user. Cheap when there are none. */
export async function countOpenMissed(db: Db, adapters: Adapters, auth: RequestAuth, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 30 * DAY_MS);
  const candidates = await db
    .select({ createdAt: callSessions.createdAt })
    .from(callSessions)
    .where(
      and(
        eq(callSessions.userId, auth.user.id),
        inArray(callSessions.category, ['callback_missed', 'unknown_number']),
        isNull(callSessions.handledAt),
        gte(callSessions.createdAt, since),
      ),
    );
  if (candidates.length === 0) return 0;
  const earliest = new Date(Math.min(...candidates.map((c) => c.createdAt.getTime())) - DAY_MS);
  let calls: PhoneCall[] = [];
  if (auth.user.crmUserId) {
    try {
      calls = await adapters.crm.listPhoneCalls({ ownerId: auth.user.crmUserId, direction: 'outgoing', from: earliest.toISOString(), limit: 2000 });
    } catch {
      calls = [];
    }
  }
  const [sessions, assignments] = await Promise.all([loadSessions(db, auth.user.id, earliest), loadAssignments(db)]);
  return buildHistory(calls, sessions, assignments).filter((r) => r.open).length;
}

/** Mark a missed callback / unknown number as done (or undo). Own sessions only; admins may act for others. */
export async function setHandled(db: Db, auth: RequestAuth, sessionId: string, handled: boolean, now: Date): Promise<{ id: string; handled: boolean }> {
  const [session] = await db.select().from(callSessions).where(eq(callSessions.id, sessionId));
  if (!session) throw notFound('Anruf nicht gefunden');
  if (session.userId !== auth.user.id && !canViewOthers(auth)) throw forbidden('Nur eigene Anrufe');
  if (session.category !== 'callback_missed' && session.category !== 'unknown_number') {
    throw badRequest('Nur verpasste Rückrufe und unbekannte Nummern lassen sich als erledigt markieren');
  }
  await db
    .update(callSessions)
    .set({ handledAt: handled ? now : null, updatedAt: now })
    .where(eq(callSessions.id, sessionId));
  await audit(db, {
    actor: auth.actor,
    action: 'history.callback_handled',
    entity: 'call_session',
    entityId: sessionId,
    field: 'handled_at',
    oldValue: session.handledAt?.toISOString() ?? null,
    newValue: handled ? now.toISOString() : null,
  });
  return { id: sessionId, handled };
}

// =====================================================================================================================
// Rückruf-Suche (6.18)
// =====================================================================================================================

const toLastCall = (c: PhoneCall | null | undefined): CallbackHit['lastCall'] =>
  c ? { at: c.start, resultCode: c.resultCode, subject: c.subject, text: c.text } : null;

export async function callbackSearch(db: Db, adapters: Adapters, rawQuery: string): Promise<CallbackSearchResponse> {
  const query = rawQuery.trim();
  const base = { query, e164: null, display: null, hits: [] as CallbackHit[], unknown: false };
  // Name / company search (header placeholder «Nummer, Name, Firma»).
  if (/[a-zà-ÿ]/i.test(query)) {
    if (query.length < 2) return { ...base, mode: 'too_short' };
    const page = await adapters.crm.listLeads({ search: query, includeHidden: true, campaign: 'all', requirePhone: false, pageSize: 8, page: 1 });
    return {
      ...base,
      mode: 'name',
      hits: page.items.map((l) => ({
        key: `name:${l.leadid}`,
        source: 'name' as const,
        leadId: l.leadid,
        name: l.fullname || [l.firstname, l.lastname].filter(Boolean).join(' ') || l.companyname,
        companyName: l.companyname,
        phoneDisplay: l.primaryPhone?.display ?? null,
        phoneE164: l.primaryPhone?.e164 ?? null,
        lastCall: null,
      })),
    };
  }

  const digits = phoneDigits(query);
  if (digits.length < 6) return { ...base, mode: 'too_short' };
  const normalized = normalizePhone(query);
  const e164 = normalized.status === 'ok' ? normalized.e164 : null;
  const display = normalized.status === 'ok' ? normalized.display : null;

  const hits: CallbackHit[] = [];
  const seen = new Set<string>();
  for (const m of await adapters.crm.searchByPhone(query)) {
    const key = `${m.entity}:${m.id}:${m.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({
      key,
      source: m.entity,
      leadId: m.leadId,
      name: m.name,
      companyName: m.companyName,
      phoneDisplay: m.phone.display ?? m.phone.raw,
      phoneE164: m.phone.e164 ?? m.phone.candidates[0] ?? null,
      lastCall: toLastCall(m.lastCall),
    });
  }

  // Numbers assigned in the portal («nicht im CRM» → einem Lead zugeordnet).
  const assignments = e164
    ? await db.select().from(phoneAssignments).where(eq(phoneAssignments.phoneE164, e164))
    : (await db.select().from(phoneAssignments)).filter((a) => nationalDigits(a.phoneE164).endsWith(digits.replace(/^0+/, '')));
  for (const a of assignments) {
    if (hits.some((h) => h.leadId === a.leadId)) continue;
    let lastCall: PhoneCall | null = null;
    try {
      [lastCall] = await adapters.crm.listPhoneCalls({ leadId: a.leadId, direction: 'outgoing', limit: 1 });
    } catch {
      lastCall = null;
    }
    hits.push({
      key: `assignment:${a.id}`,
      source: 'assignment',
      leadId: a.leadId,
      name: a.leadName ?? a.companyName ?? 'Lead',
      companyName: a.companyName,
      phoneDisplay: display ?? a.phoneE164,
      phoneE164: a.phoneE164,
      lastCall: toLastCall(lastCall),
    });
  }
  return { ...base, mode: 'phone', e164, display, hits, unknown: !!e164 && hits.length === 0 };
}

export async function assignPhone(
  db: Db,
  adapters: Adapters,
  auth: RequestAuth,
  input: { phone: string; leadId: string },
): Promise<{ id: string; phoneE164: string; leadId: string; leadName: string | null; companyName: string | null }> {
  const normalized = normalizePhone(input.phone);
  if (normalized.status !== 'ok' || !normalized.e164) throw badRequest('Nummer prüfen: keine gültige Telefonnummer', 'invalid_phone');
  const lead = await adapters.crm.getLead(input.leadId);
  if (!lead) throw notFound('Lead nicht gefunden');
  const leadName = lead.fullname || [lead.firstname, lead.lastname].filter(Boolean).join(' ') || null;
  const [existing] = await db.select().from(phoneAssignments).where(eq(phoneAssignments.phoneE164, normalized.e164));
  const values = { phoneE164: normalized.e164, leadId: lead.leadid, leadName, companyName: lead.companyname, assignedBy: auth.user.id };
  const [row] = existing
    ? await db.update(phoneAssignments).set(values).where(eq(phoneAssignments.id, existing.id)).returning()
    : await db.insert(phoneAssignments).values(values).returning();
  await audit(db, {
    actor: auth.actor,
    action: 'history.phone_assign',
    entity: 'phone_assignment',
    entityId: row.id,
    field: 'lead_id',
    oldValue: existing?.leadId ?? null,
    newValue: lead.leadid,
  });
  return { id: row.id, phoneE164: row.phoneE164, leadId: row.leadId, leadName: row.leadName, companyName: row.companyName };
}

export async function removeAssignment(db: Db, auth: RequestAuth, id: string): Promise<void> {
  const [row] = await db.select().from(phoneAssignments).where(eq(phoneAssignments.id, id));
  if (!row) throw notFound('Zuordnung nicht gefunden');
  if (row.assignedBy !== auth.user.id && !canViewOthers(auth)) throw forbidden('Nur eigene Zuordnungen');
  await db.delete(phoneAssignments).where(eq(phoneAssignments.id, id));
  await audit(db, {
    actor: auth.actor,
    action: 'history.phone_unassign',
    entity: 'phone_assignment',
    entityId: id,
    field: 'lead_id',
    oldValue: row.leadId,
    newValue: null,
  });
}
