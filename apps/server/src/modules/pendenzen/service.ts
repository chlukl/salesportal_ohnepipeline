/**
 * Pendenzen service (INTENT 6.16): aggregates per person – CRM tasks, bookings + briefings, cancellations, unfinished
 * calls, analyses for approval, open change sets, errors. Reads other modules' tables read-only; writes only its own
 * `pendenz_states` / `saved_filters` (scope 'pendenzen') and CRM tasks via the adapter.
 */
import {
  formatZurich,
  PENDENZ_TEAM,
  RESULT_GROUP_LABELS,
  type CrmTask,
  type Lead,
  type PendenzEntry,
  type PendenzFilter,
  type PendenzDue,
  type PendenzKind,
  type PendenzPerson,
  type PendenzenResponse,
  type ResultGroupKey,
  type Role,
} from '@sales-portal/shared';
import { and, desc, eq, gte, inArray, isNull, or } from 'drizzle-orm';
import type { RequestAuth } from '../../auth/rbac';
import type { Db } from '../../db/client';
import { analyses, bookings, callSessions, changeSets, notifications, pendenzStates, savedFilters, userRoles, users } from '../../db/schema';
import type { Adapters } from '../../integrations';
import { audit } from '../../lib/audit';
import { forbidden, notFound, unprocessable } from '../../lib/errors';
import {
  applyFilter,
  canReplanBookings,
  cancellationTarget,
  classifyDue,
  countsForHeader,
  deriveOrigin,
  isUnfinishedCall,
  PENDENZ_DUES,
  scopeForRoles,
  sortPendenzen,
} from './rules';

const DAY_MS = 86_400_000;

export interface TargetPerson extends PendenzPerson {
  crmUserId: string | null;
  isSelf: boolean;
}

// =====================================================================================================================
// Object-level authorization
// =====================================================================================================================

/** Only real admins (also while «Ansicht als» is active) may look at other persons' Pendenzen / history (ARCHITECTURE §5.4). */
export function canViewOthers(auth: RequestAuth): boolean {
  return auth.isRealAdmin;
}

/**
 * Resolve whose Pendenzen are requested. Self → effective roles (respects «Ansicht als»);
 * another person → 403 unless real admin, then that person's real roles.
 */
export async function resolveTarget(db: Db, auth: RequestAuth, userId: string | undefined | null): Promise<TargetPerson> {
  if (!userId || userId === auth.user.id) {
    return { id: auth.user.id, displayName: auth.user.displayName, roles: [...auth.effectiveRoles], crmUserId: auth.user.crmUserId, isSelf: true };
  }
  if (!canViewOthers(auth)) throw forbidden('Pendenzen anderer Personen sieht nur der Admin');
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw notFound('Person nicht gefunden');
  const roles = await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId));
  return { id: user.id, displayName: user.displayName, roles: roles.map((r) => r.role as Role), crmUserId: user.crmUserId, isSelf: false };
}

/**
 * Whose Pendenzen are shown on the list page. Unlike {@link resolveTarget} (used by every action), any logged-in
 * person may LOOK at a colleague's Pendenzen; the result is read-only unless it's the own list or a real admin.
 */
export async function resolveViewTarget(db: Db, auth: RequestAuth, userId: string | undefined | null): Promise<TargetPerson> {
  if (!userId || userId === auth.user.id) return resolveTarget(db, auth, null);
  const [user] = await db.select().from(users).where(and(eq(users.id, userId), eq(users.isActive, true)));
  if (!user) throw notFound('Person nicht gefunden');
  const roles = await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId));
  return { id: user.id, displayName: user.displayName, roles: roles.map((r) => r.role as Role), crmUserId: user.crmUserId, isSelf: false };
}

/** Actions that change something – removed from the list when it is shown read-only. */
const MUTATING_ACTIONS = new Set<PendenzEntry['actions'][number]>(['complete', 'reschedule', 'mark_done', 'snooze']);

function toReadOnly(item: PendenzEntry): PendenzEntry {
  return { ...item, actions: item.actions.filter((a) => !MUTATING_ACTIONS.has(a)) };
}

export async function listPersons(db: Db): Promise<PendenzPerson[]> {
  const [rows, roles] = await Promise.all([
    db.select({ id: users.id, displayName: users.displayName }).from(users).where(eq(users.isActive, true)),
    db.select().from(userRoles),
  ]);
  return rows
    .map((u) => ({ id: u.id, displayName: u.displayName, roles: roles.filter((r) => r.userId === u.id).map((r) => r.role as Role) }))
    .filter((p) => p.roles.length > 0)
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'de-CH'));
}

// =====================================================================================================================
// Labels
// =====================================================================================================================

const TASK_TYPE_LABELS: Record<CrmTask['taskType'], string> = {
  callback: 'Rückruf',
  follow_up: 'Nachfassen',
  research: 'Research',
  other: 'Aufgabe',
};

const BOOKING_STATUS_LABELS = { booked: 'gebucht', rescheduled: 'verschoben', cancelled: 'abgesagt', held: 'durchgeführt' } as const;
const BRIEFING_STATUS_LABELS = { open: 'offen', read: 'gelesen', prepared: 'Vorbereitung erledigt' } as const;
const CHANGE_SET_STATUS_LABELS: Record<string, string> = { draft: 'Entwurf', pending: 'wartet auf Freigabe', conflict: 'Konflikt prüfen' };
const CHANGE_SET_KIND_LABELS: Record<string, string> = {
  call_result: 'Anrufergebnis',
  not_reached: 'Nicht erreicht',
  analysis: 'KI-Analyse',
  task: 'Aufgabe',
  booking: 'Termin',
  contact_person: 'Ansprechperson',
  phone_fix: 'Telefonnummer',
  mail: 'Mail',
  manual: 'Änderung',
};

const fmt = (d: Date | string) => formatZurich(d, 'dd.MM. HH:mm');
const join = (...parts: (string | null | undefined)[]) => parts.filter((p) => p && p.trim()).join(' · ') || null;

// =====================================================================================================================
// Collect + build
// =====================================================================================================================

interface Draft extends Omit<PendenzEntry, 'due' | 'origin'> {
  bookingOrigin?: PendenzEntry['origin'] | null;
  fromColdcall?: boolean;
}

/** Load every source of the person and turn it into Pendenzen (unfiltered, unsorted, with due + origin). */
export async function collectPendenzen(
  db: Db,
  adapters: Adapters,
  person: TargetPerson,
  now: Date,
  /** `enrich: false` skips the CRM lead lookup (names, campaign origin) – used by the header counter. */
  options: { includeDone?: boolean; enrich?: boolean } = {},
): Promise<{ items: PendenzEntry[]; warnings: string[] }> {
  const scope = scopeForRoles(person.roles);
  const includeDone = options.includeDone ?? false;
  const warnings: string[] = [];
  const drafts = new Map<string, Draft>();
  const add = (d: Draft) => {
    if (!drafts.has(d.id)) drafts.set(d.id, d);
  };
  const recent = new Date(now.getTime() - 30 * DAY_MS);
  const doneWindow = new Date(now.getTime() - 14 * DAY_MS);

  const states = await db.select().from(pendenzStates).where(eq(pendenzStates.userId, person.id));
  const stateByKey = new Map(states.map((s) => [s.itemKey, s]));

  // ---- CRM tasks ---------------------------------------------------------------------------------------------------
  if (scope.tasks && person.crmUserId) {
    try {
      const open = await adapters.crm.listTasks({ ownerId: person.crmUserId, status: 'open' });
      const done = includeDone ? await adapters.crm.listTasks({ ownerId: person.crmUserId, status: 'completed' }) : [];
      for (const t of [...open, ...done.filter((x) => x.completedon && Date.parse(x.completedon) >= doneWindow.getTime())]) {
        const isOpen = t.statecode === 0;
        add({
          id: `task:${t.id}`,
          kind: 'task',
          title: t.subject,
          subtitle: join(t.leadName, t.companyName && t.subject.includes(t.companyName) ? null : t.companyName, t.description),
          dueAt: t.dueAt,
          ownerUserId: person.id,
          ownerName: t.ownerName ?? person.displayName,
          leadId: t.leadId,
          companyName: t.companyName,
          status: isOpen ? 'open' : 'done',
          ref: { type: 'task', id: t.id },
          link: t.leadId ? `/lead/${t.leadId}` : null,
          statusLabel: TASK_TYPE_LABELS[t.taskType] ?? 'Aufgabe',
          tone: 'neutral',
          actions: isOpen ? ['complete', 'reschedule', ...(t.leadId ? (['open_lead'] as const) : [])] : t.leadId ? ['open_lead'] : [],
          taskType: t.taskType,
          snoozedUntil: null,
          fromColdcall: scope.coldcall && (t.taskType === 'callback' || t.taskType === 'research'),
        });
      }
    } catch {
      warnings.push('Aufgaben aus dem CRM konnten gerade nicht geladen werden.');
    }
  }

  // ---- Coldcall: unfinished calls, approvals, errors, analyses ------------------------------------------------------
  if (scope.coldcall) {
    const sessions = await db
      .select()
      .from(callSessions)
      .where(and(eq(callSessions.userId, person.id), isNull(callSessions.crmPhonecallId), gte(callSessions.createdAt, new Date(now.getTime() - 60 * DAY_MS))));
    const ownSets = await db
      .select()
      .from(changeSets)
      .where(and(eq(changeSets.createdBy, person.id), inArray(changeSets.status, ['draft', 'pending', 'conflict', 'failed'])));
    const setStatus = new Map<string, string>();
    const sessionSetIds = sessions.map((s) => s.changeSetId).filter((x): x is string => !!x);
    if (sessionSetIds.length) {
      for (const cs of await db.select({ id: changeSets.id, status: changeSets.status }).from(changeSets).where(inArray(changeSets.id, sessionSetIds))) {
        setStatus.set(cs.id, cs.status);
      }
    }
    const unfinishedSessionIds = new Set<string>();
    for (const s of sessions) {
      const csStatus = s.changeSetId ? (setStatus.get(s.changeSetId) ?? null) : null;
      if (!isUnfinishedCall(s, csStatus)) continue;
      unfinishedSessionIds.add(s.id);
      const at = s.dialedAt ?? s.createdAt;
      const missingResult = !s.resultGroup;
      const resultLabel = s.resultGroup ? (RESULT_GROUP_LABELS[s.resultGroup as ResultGroupKey] ?? s.resultGroup) : null;
      add({
        id: `call:${s.id}`,
        kind: 'unfinished_call',
        title: s.companyName ?? s.leadName ?? s.phoneDisplay ?? 'Anruf',
        subtitle: join(
          s.companyName ? s.leadName : null,
          `${s.direction === 'inbound' ? 'Rückruf' : 'Anruf'} vom ${fmt(at)}`,
          missingResult ? 'Ergebnis fehlt' : `«${resultLabel}» noch nicht freigegeben`,
        ),
        dueAt: at.toISOString(),
        ownerUserId: person.id,
        ownerName: person.displayName,
        leadId: s.leadId,
        companyName: s.companyName,
        status: 'open',
        ref: { type: 'call_session', id: s.id },
        link: s.leadId ? `/lead/${s.leadId}?anruf=${s.id}` : null,
        statusLabel: missingResult ? 'Ergebnis fehlt' : 'Freigabe fehlt',
        tone: 'warning',
        actions: s.leadId ? ['open_lead'] : [],
        taskType: null,
        snoozedUntil: null,
        fromColdcall: true,
      });
    }
    for (const cs of ownSets) {
      if (cs.status === 'failed') continue; // handled below (errors)
      // AI analysis drafts are listed once, as «Analysen zur Freigabe» (below), not again as an approval.
      if (cs.kind === 'analysis') continue;
      // The call's own result draft is shown as the unfinished call; booking/mail drafts of that call stay visible.
      if (cs.callSessionId && unfinishedSessionIds.has(cs.callSessionId) && (cs.kind === 'call_result' || cs.kind === 'not_reached')) continue;
      add({
        id: `approval:${cs.id}`,
        kind: 'approval',
        title: `Freigabe: ${CHANGE_SET_KIND_LABELS[cs.kind] ?? 'Änderung'}`,
        subtitle: `Entwurf vom ${fmt(cs.createdAt)}`,
        dueAt: null,
        ownerUserId: person.id,
        ownerName: person.displayName,
        leadId: cs.leadId,
        companyName: null,
        status: 'open',
        ref: { type: 'change_set', id: cs.id },
        link: `/lead/${cs.leadId}?freigabe=${cs.id}`,
        statusLabel: CHANGE_SET_STATUS_LABELS[cs.status] ?? cs.status,
        tone: cs.status === 'conflict' ? 'warning' : 'info',
        actions: ['open_lead'],
        taskType: null,
        snoozedUntil: null,
        fromColdcall: true,
      });
    }
    const ownAnalyses = await db
      .select()
      .from(analyses)
      .where(and(eq(analyses.ownerUserId, person.id), eq(analyses.kind, 'call'), inArray(analyses.status, ['ready', 'failed'])));
    // Only actionable analyses: «ready» can be approved, «failed» can be dismissed in the review list.
    for (const a of ownAnalyses) {
      const ready = a.status === 'ready';
      add({
        id: `analysis:${a.id}`,
        kind: 'analysis',
        title: 'KI-Analyse prüfen',
        subtitle: ready ? `Bereit seit ${fmt(a.updatedAt)}` : 'Analyse fehlgeschlagen – verwerfen oder Notiz von Hand ergänzen',
        dueAt: null,
        ownerUserId: person.id,
        ownerName: person.displayName,
        leadId: a.leadId,
        companyName: null,
        status: 'open',
        ref: { type: 'analysis', id: a.id },
        link: `/lead/${a.leadId}?analyse=${a.id}`,
        statusLabel: ready ? 'zur Freigabe' : 'fehlgeschlagen',
        tone: ready ? 'info' : 'warning',
        actions: ['open_lead'],
        taskType: null,
        snoozedUntil: null,
        fromColdcall: true,
      });
    }
  }

  // ---- Errors: failed CRM pushes (own; admin: all) -----------------------------------------------------------------
  if (scope.coldcall || scope.allErrors) {
    const failed = await db
      .select({ id: changeSets.id, leadId: changeSets.leadId, kind: changeSets.kind, error: changeSets.error, updatedAt: changeSets.updatedAt, createdBy: changeSets.createdBy, ownerName: users.displayName })
      .from(changeSets)
      .leftJoin(users, eq(users.id, changeSets.createdBy))
      .where(scope.allErrors ? eq(changeSets.status, 'failed') : and(eq(changeSets.status, 'failed'), eq(changeSets.createdBy, person.id)))
      .orderBy(desc(changeSets.updatedAt))
      .limit(200);
    for (const cs of failed) {
      add({
        id: `error:${cs.id}`,
        kind: 'error',
        title: `CRM-Push fehlgeschlagen: ${CHANGE_SET_KIND_LABELS[cs.kind] ?? 'Änderung'}`,
        subtitle: join(cs.error ?? 'Unbekannter Fehler', cs.createdBy !== person.id ? `von ${cs.ownerName ?? 'unbekannt'}` : null),
        dueAt: null,
        ownerUserId: cs.createdBy,
        ownerName: cs.ownerName ?? null,
        leadId: cs.leadId,
        companyName: null,
        status: 'open',
        ref: { type: 'change_set', id: cs.id },
        link: `/lead/${cs.leadId}?freigabe=${cs.id}`,
        statusLabel: 'Fehler',
        tone: 'danger',
        actions: ['open_lead', 'mark_done'],
        taskType: null,
        snoozedUntil: null,
        fromColdcall: true,
      });
    }
  }

  // ---- Bookings, briefings, cancellations ---------------------------------------------------------------------------
  const bookingConditions = [];
  if (scope.allBookings) bookingConditions.push(gte(bookings.endAt, new Date(now.getTime() - 60 * DAY_MS)));
  else {
    const who = [];
    if (scope.salesBookings) who.push(eq(bookings.salesUserId, person.id));
    if (scope.coldcall) who.push(eq(bookings.createdBy, person.id));
    if (who.length) bookingConditions.push(and(or(...who), gte(bookings.endAt, new Date(now.getTime() - 60 * DAY_MS))));
  }
  if (bookingConditions.length) {
    const rows = await db.select().from(bookings).where(bookingConditions[0]);
    const showsMeetings = scope.salesBookings || scope.allBookings;
    const canReplan = canReplanBookings(person.roles);
    for (const b of rows) {
      const isAttendee = scope.allBookings || b.salesUserId === person.id;
      const who = join(b.leadName, b.extraCall ? 'Zusatzcall' : null);
      // Cancellations / reschedules: what needs re-planning (coldcaller: own bookings; sales/AI: their meetings).
      if ((b.status === 'cancelled' || b.status === 'rescheduled') && b.updatedAt >= recent) {
        const cancelled = b.status === 'cancelled';
        const target = cancellationTarget({ leadId: b.leadId, cancelled, canReplan });
        add({
          id: `cancellation:${b.id}`,
          kind: 'cancellation',
          title: `${cancelled ? 'Termin abgesagt' : 'Termin verschoben'}: ${b.companyName ?? b.leadName ?? 'Lead'}`,
          subtitle: join(who, cancelled ? `war am ${fmt(b.startAt)}${target.replan ? ' – neu planen' : ''}` : `neu am ${fmt(b.startAt)}`),
          dueAt: (cancelled ? b.updatedAt : b.startAt).toISOString(),
          ownerUserId: person.id,
          ownerName: person.displayName,
          leadId: b.leadId,
          companyName: b.companyName,
          status: 'open',
          ref: { type: 'booking', id: b.id },
          link: target.link,
          statusLabel: BOOKING_STATUS_LABELS[b.status],
          tone: cancelled ? 'danger' : 'warning',
          actions: ['open_lead', 'mark_done'],
          taskType: null,
          snoozedUntil: null,
          bookingOrigin: b.origin,
        });
      }
      if (!showsMeetings || !isAttendee) continue;
      // Termine (first meetings) with status.
      if (b.status !== 'cancelled') {
        const past = b.endAt.getTime() < now.getTime() || b.status === 'held';
        add({
          id: `booking:${b.id}`,
          kind: 'booking',
          title: b.companyName ?? b.leadName ?? 'Erstgespräch',
          subtitle: join(`Erstgespräch ${fmt(b.startAt)}`, who),
          dueAt: b.startAt.toISOString(),
          ownerUserId: b.salesUserId,
          ownerName: null,
          leadId: b.leadId,
          companyName: b.companyName,
          status: past ? 'done' : 'open',
          ref: { type: 'booking', id: b.id },
          link: `/lead/${b.leadId}`,
          statusLabel: past ? BOOKING_STATUS_LABELS.held : BOOKING_STATUS_LABELS[b.status],
          tone: b.status === 'rescheduled' && !past ? 'warning' : past ? 'success' : 'info',
          actions: ['open_lead', 'open_briefing'],
          taskType: null,
          snoozedUntil: null,
          bookingOrigin: b.origin,
        });
        // Briefing for upcoming meetings: open / read / preparation done.
        if (!past) {
          const prepDue = new Date(Math.max(b.startAt.getTime() - 7 * DAY_MS, b.createdAt.getTime()));
          const done = b.briefingStatus === 'prepared' || (!b.needsPreparation && b.briefingStatus === 'read');
          add({
            id: `briefing:${b.id}`,
            kind: 'briefing',
            title: `Briefing: ${b.companyName ?? b.leadName ?? 'Erstgespräch'}`,
            subtitle: join(
              `Termin ${fmt(b.startAt)}`,
              b.needsPreparation ? `Vorbereitung nötig${b.preparationNote ? `: ${b.preparationNote}` : ''}` : null,
            ),
            dueAt: (b.needsPreparation ? prepDue : b.startAt).toISOString(),
            ownerUserId: b.salesUserId,
            ownerName: null,
            leadId: b.leadId,
            companyName: b.companyName,
            status: done ? 'done' : 'open',
            ref: { type: 'booking', id: b.id },
            link: `/lead/${b.leadId}?briefing=${b.id}`,
            statusLabel: BRIEFING_STATUS_LABELS[b.briefingStatus],
            tone: b.needsPreparation && !done ? 'warning' : 'neutral',
            actions: done ? ['open_briefing'] : ['open_briefing', 'mark_done', 'open_lead'],
            taskType: null,
            snoozedUntil: null,
            bookingOrigin: b.origin,
          });
        }
      }
    }
  }

  // ---- Notifications (mail failed, campaign replies, declines) ------------------------------------------------------
  const notes = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, person.id),
        isNull(notifications.doneAt),
        inArray(notifications.kind, ['mail_failed', 'campaign_reply', 'attendee_declined', 'internal_declined']),
        gte(notifications.createdAt, recent),
      ),
    );
  for (const n of notes) {
    const kind: PendenzKind = n.kind === 'mail_failed' ? 'error' : n.kind === 'campaign_reply' ? 'campaign_reply' : 'cancellation';
    const leadId = n.entity === 'lead' ? n.entityId : null;
    add({
      id: `notification:${n.id}`,
      kind,
      title: n.title,
      subtitle: n.body,
      dueAt: n.kind === 'campaign_reply' || n.kind === 'mail_failed' ? null : n.createdAt.toISOString(),
      ownerUserId: person.id,
      ownerName: person.displayName,
      leadId,
      companyName: null,
      status: 'open',
      ref: { type: 'notification', id: n.id },
      link: n.link && n.link.startsWith('/') && !n.link.startsWith('//') ? n.link : leadId ? `/lead/${leadId}` : null,
      statusLabel: n.kind === 'mail_failed' ? 'Mail nicht gesendet' : n.kind === 'campaign_reply' ? 'Antwort aus Kampagne' : 'abgelehnt',
      tone: n.severity === 'error' ? 'danger' : n.severity === 'warning' ? 'warning' : 'info',
      actions: [...(leadId ? (['open_lead'] as const) : []), 'mark_done'],
      taskType: null,
      snoozedUntil: null,
    });
  }

  // ---- Lead enrichment (names, company, campaign origin) -----------------------------------------------------------
  const leadIds = [...new Set([...drafts.values()].map((d) => d.leadId).filter((x): x is string => !!x))];
  let leads = new Map<string, Lead>();
  if (leadIds.length && options.enrich !== false) {
    try {
      leads = new Map((await adapters.crm.getLeads(leadIds)).map((l) => [l.leadid, l]));
    } catch {
      warnings.push('Firmennamen aus dem CRM konnten gerade nicht geladen werden.');
    }
  }

  const items: PendenzEntry[] = [];
  for (const d of drafts.values()) {
    const lead = d.leadId ? leads.get(d.leadId) : undefined;
    const state = stateByKey.get(d.id);
    const { bookingOrigin, fromColdcall, ...rest } = d;
    const entry: PendenzEntry = {
      ...rest,
      companyName: d.companyName ?? lead?.companyname ?? null,
      due: 'none',
      origin: deriveOrigin({ kind: d.kind, bookingOrigin, leadFromCampaign: lead ? lead.campaign.inCampaign || lead.campaign.fromCampaign : null, fromColdcall }),
    };
    if ((d.kind === 'analysis' || d.kind === 'approval' || d.kind === 'error') && lead) {
      entry.subtitle = join(lead.companyname, lead.fullname, d.subtitle);
    }
    // Portal-side state: «erledigt» / «verschoben bis» (CRM tasks are handled in the CRM).
    if (state && d.kind !== 'task') {
      if (state.doneAt && entry.status === 'open') {
        entry.status = 'done';
        entry.actions = entry.actions.filter((a) => a !== 'mark_done' && a !== 'snooze');
      }
      if (state.snoozedUntil && state.snoozedUntil.getTime() > now.getTime() && entry.status === 'open') {
        entry.dueAt = state.snoozedUntil.toISOString();
        entry.snoozedUntil = entry.dueAt;
      }
    }
    if (entry.status === 'open' && entry.actions.includes('mark_done') && !entry.actions.includes('snooze')) entry.actions.push('snooze');
    entry.due = classifyDue(entry.dueAt, now);
    if (entry.kind === 'task' && entry.status === 'open' && entry.due === 'overdue') entry.tone = 'warning';
    if (entry.status === 'done' && !includeDone) continue;
    items.push(entry);
  }
  return { items, warnings };
}

export async function listPendenzen(
  db: Db,
  adapters: Adapters,
  auth: RequestAuth,
  filter: PendenzFilter,
  now: Date,
): Promise<PendenzenResponse> {
  const status = filter.status ?? 'open';
  const team = filter.userId === PENDENZ_TEAM;

  let items: PendenzEntry[];
  let warnings: string[];
  let person: PendenzPerson;
  let coldcallerFirst: boolean;
  let readOnly: boolean;

  if (team) {
    // Everyone's Pendenzen in one list. Shared items (a first meeting of Manuel + Nico) appear once with both names.
    const persons = await listPersons(db);
    const merged = new Map<string, PendenzEntry>();
    const warningSet = new Set<string>();
    for (const p of persons) {
      const target = await resolveViewTarget(db, auth, p.id);
      const res = await collectPendenzen(db, adapters, target, now, { includeDone: status !== 'open' });
      res.warnings.forEach((w) => warningSet.add(w));
      for (const item of res.items) {
        const existing = merged.get(item.id);
        if (existing) existing.ownerNames!.push(p.displayName);
        else merged.set(item.id, { ...item, ownerNames: [p.displayName] });
      }
    }
    // «für Manuel & Nico» in the row (the web shows ownerName for foreign lists).
    const names = (n: string[]) => (n.length > 1 ? `${n.slice(0, -1).join(', ')} & ${n[n.length - 1]}` : n[0]);
    items = [...merged.values()].map((i) => ({ ...i, ownerName: names(i.ownerNames!) }));
    warnings = [...warningSet];
    person = { id: PENDENZ_TEAM, displayName: 'Ganzes Team', roles: [] };
    coldcallerFirst = false;
    // No single person to act for (actions carry one userId) → the team view is read-only, also for admins.
    readOnly = true;
  } else {
    const target = await resolveViewTarget(db, auth, filter.userId);
    ({ items, warnings } = await collectPendenzen(db, adapters, target, now, { includeDone: status !== 'open' }));
    person = { id: target.id, displayName: target.displayName, roles: target.roles };
    coldcallerFirst = target.roles.includes('coldcaller');
    readOnly = !target.isSelf && !auth.isRealAdmin;
  }
  if (readOnly) items = items.map(toReadOnly);

  const { items: filtered, counts } = applyFilter(items, { ...filter, status });
  const dueCounts = Object.fromEntries(PENDENZ_DUES.map((d) => [d, 0])) as Record<PendenzDue, number>;
  for (const i of applyFilter(items, { ...filter, status, due: undefined }).items) dueCounts[i.due] += 1;
  return { items: sortPendenzen(filtered, coldcallerFirst), counts, dueCounts, person, readOnly, coldcallerFirst, warnings };
}

/** Header counter «offene Pendenzen» for the current user (respects «Ansicht als»). */
export async function countOpenPendenzen(db: Db, adapters: Adapters, auth: RequestAuth, now: Date): Promise<number> {
  const person = await resolveTarget(db, auth, null);
  const { items } = await collectPendenzen(db, adapters, person, now, { enrich: false });
  return countsForHeader(items);
}

// =====================================================================================================================
// Actions
// =====================================================================================================================

/** Find an open CRM task of the target person – the object-level check for complete / reschedule. */
async function findOwnTask(adapters: Adapters, person: TargetPerson, taskId: string): Promise<CrmTask> {
  if (!person.crmUserId) throw notFound('Aufgabe nicht gefunden');
  const tasks = await adapters.crm.listTasks({ ownerId: person.crmUserId, status: 'open' });
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw notFound('Aufgabe nicht gefunden');
  return task;
}

export async function completeTask(db: Db, adapters: Adapters, auth: RequestAuth, taskId: string, userId?: string): Promise<{ task: CrmTask }> {
  const person = await resolveTarget(db, auth, userId);
  const task = await findOwnTask(adapters, person, taskId);
  await adapters.crm.completeTask(taskId, auth.actor);
  await audit(db, {
    actor: auth.actor,
    action: 'pendenzen.task_complete',
    entity: 'task',
    entityId: taskId,
    field: 'statecode',
    oldValue: 0,
    newValue: 1,
    meta: { leadId: task.leadId, onBehalfOf: person.isSelf ? null : person.id },
  });
  return { task: { ...task, statecode: 1 } };
}

export async function rescheduleTask(
  db: Db,
  adapters: Adapters,
  auth: RequestAuth,
  taskId: string,
  dueAt: string,
  userId?: string,
): Promise<{ previousDueAt: string | null; dueAt: string }> {
  const person = await resolveTarget(db, auth, userId);
  const task = await findOwnTask(adapters, person, taskId);
  await adapters.crm.rescheduleTask(taskId, dueAt, auth.actor);
  await audit(db, {
    actor: auth.actor,
    action: 'pendenzen.task_reschedule',
    entity: 'task',
    entityId: taskId,
    field: 'scheduledend',
    oldValue: task.dueAt,
    newValue: dueAt,
    meta: { leadId: task.leadId, onBehalfOf: person.isSelf ? null : person.id },
  });
  return { previousDueAt: task.dueAt, dueAt };
}

/** «erledigt» / «verschoben bis» for portal-side Pendenzen (not CRM tasks). */
export async function setPendenzState(
  db: Db,
  auth: RequestAuth,
  input: { itemKey: string; done?: boolean; snoozedUntil?: string | null; userId?: string },
  now: Date,
): Promise<{ itemKey: string; done: boolean; snoozedUntil: string | null }> {
  const person = await resolveTarget(db, auth, input.userId);
  const [existing] = await db
    .select()
    .from(pendenzStates)
    .where(and(eq(pendenzStates.userId, person.id), eq(pendenzStates.itemKey, input.itemKey)));
  const doneAt = input.done === undefined ? (existing?.doneAt ?? null) : input.done ? now : null;
  const snoozedUntil = input.snoozedUntil === undefined ? (existing?.snoozedUntil ?? null) : input.snoozedUntil ? new Date(input.snoozedUntil) : null;
  if (existing) {
    await db.update(pendenzStates).set({ doneAt, snoozedUntil, updatedAt: now }).where(eq(pendenzStates.id, existing.id));
  } else {
    await db.insert(pendenzStates).values({ userId: person.id, itemKey: input.itemKey, doneAt, snoozedUntil, updatedAt: now });
  }
  if (!person.isSelf) {
    await audit(db, {
      actor: auth.actor,
      action: 'pendenzen.state',
      entity: 'pendenz',
      entityId: input.itemKey,
      oldValue: existing ? { done: !!existing.doneAt, snoozedUntil: existing.snoozedUntil?.toISOString() ?? null } : null,
      newValue: { done: !!doneAt, snoozedUntil: snoozedUntil?.toISOString() ?? null },
      meta: { onBehalfOf: person.id },
    });
  }
  return { itemKey: input.itemKey, done: !!doneAt, snoozedUntil: snoozedUntil?.toISOString() ?? null };
}

// =====================================================================================================================
// Saved filters (scope 'pendenzen', own user only)
// =====================================================================================================================

export interface SavedPendenzFilter {
  id: string;
  name: string;
  filter: PendenzFilter;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

type SavedRow = typeof savedFilters.$inferSelect;
const toSaved = (r: SavedRow): SavedPendenzFilter => ({
  id: r.id,
  name: r.name,
  filter: r.filter as PendenzFilter,
  isDefault: r.isDefault,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export const MAX_SAVED_FILTERS = 30;

export async function listSavedFilters(db: Db, userId: string): Promise<SavedPendenzFilter[]> {
  const rows = await db
    .select()
    .from(savedFilters)
    .where(and(eq(savedFilters.userId, userId), eq(savedFilters.scope, 'pendenzen')))
    .orderBy(savedFilters.name);
  return rows.map(toSaved);
}

export async function createSavedFilter(
  db: Db,
  userId: string,
  input: { name: string; filter: PendenzFilter; isDefault?: boolean },
): Promise<SavedPendenzFilter> {
  const existing = await listSavedFilters(db, userId);
  if (existing.length >= MAX_SAVED_FILTERS) throw unprocessable(`Höchstens ${MAX_SAVED_FILTERS} gespeicherte Filter`, 'too_many_filters');
  return db.transaction(async (tx) => {
    if (input.isDefault) {
      await tx.update(savedFilters).set({ isDefault: false }).where(and(eq(savedFilters.userId, userId), eq(savedFilters.scope, 'pendenzen')));
    }
    const [row] = await tx
      .insert(savedFilters)
      .values({ userId, scope: 'pendenzen', name: input.name, filter: input.filter as Record<string, unknown>, isDefault: !!input.isDefault })
      .returning();
    return toSaved(row);
  });
}

export async function updateSavedFilter(
  db: Db,
  userId: string,
  id: string,
  input: { name?: string; filter?: PendenzFilter; isDefault?: boolean },
): Promise<SavedPendenzFilter> {
  return db.transaction(async (tx) => {
    const own = and(eq(savedFilters.id, id), eq(savedFilters.userId, userId), eq(savedFilters.scope, 'pendenzen'));
    const [row] = await tx.select().from(savedFilters).where(own);
    if (!row) throw notFound('Filter nicht gefunden');
    if (input.isDefault) {
      await tx.update(savedFilters).set({ isDefault: false }).where(and(eq(savedFilters.userId, userId), eq(savedFilters.scope, 'pendenzen')));
    }
    const [updated] = await tx
      .update(savedFilters)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.filter !== undefined ? { filter: input.filter as Record<string, unknown> } : {}),
        ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        updatedAt: new Date(),
      })
      .where(own)
      .returning();
    return toSaved(updated);
  });
}

export async function deleteSavedFilter(db: Db, userId: string, id: string): Promise<void> {
  const deleted = await db
    .delete(savedFilters)
    .where(and(eq(savedFilters.id, id), eq(savedFilters.userId, userId), eq(savedFilters.scope, 'pendenzen')))
    .returning({ id: savedFilters.id });
  if (deleted.length === 0) throw notFound('Filter nicht gefunden');
}
