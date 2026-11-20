/**
 * Mock calendar on `mock_calendar_events` (seeded with busy time for Manuel, Nico, Lukas, Markus and demo bookings
 * incl. blockers with extended property KlsTerminId).
 *
 * Behaves like Graph where it matters for the portal:
 * - `createEvent` in the organizer's mailbox also puts a copy into the calendars of internal attendees (portal users),
 *   same `iCalUId`, without the organizer's extended properties.
 * - updates of the organizer's event propagate to the copies; deleting it cancels the copies.
 * - `delta` returns changes since the token (incl. deletions) – every write bumps `version` and `lastModified`.
 * - `simulate*` helpers (demo / tests) imitate what customers and colleagues do in Outlook: decline, move, cancel.
 */
import { randomUUID } from 'node:crypto';
import type { CalendarAttendee, CalendarDelta, CalendarEvent, CalendarEventInput, MailboxSchedule } from '@sales-portal/shared';
import { and, eq, gte, gt, inArray, isNull, lt, ne, sql, type InferSelectModel } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { mockCalendarEvents, users } from '../../db/schema';
import { badRequest, notFound } from '../../lib/errors';
import type { AdapterDeps } from '../types';
import type { CalendarAdapter } from './types';

type Row = InferSelectModel<typeof mockCalendarEvents>;

interface DeltaToken {
  /** Highest lastModified (ms) delivered so far. */
  t: number;
  /** `id:version` of rows delivered with lastModified === t (same-millisecond writes are not lost). */
  seen: string[];
}

const lower = (s: string) => s.trim().toLowerCase();

function encodeToken(token: DeltaToken): string {
  return `mock1.${Buffer.from(JSON.stringify(token)).toString('base64url')}`;
}

function decodeToken(token: string | null): DeltaToken | null {
  if (!token) return null;
  if (!token.startsWith('mock1.')) throw badRequest('Ungültiges Delta-Token');
  try {
    const parsed = JSON.parse(Buffer.from(token.slice(6), 'base64url').toString('utf8')) as DeltaToken;
    if (typeof parsed.t !== 'number' || !Array.isArray(parsed.seen)) throw new Error('shape');
    return parsed;
  } catch {
    throw badRequest('Ungültiges Delta-Token');
  }
}

export function toCalendarEvent(r: Row): CalendarEvent {
  return {
    id: r.id,
    mailbox: r.mailbox,
    subject: r.subject,
    body: r.body,
    start: r.startAt.toISOString(),
    end: r.endAt.toISOString(),
    showAs: r.showAs,
    categories: r.categories ?? [],
    isCancelled: r.isCancelled,
    organizer: r.organizer,
    attendees: r.attendees ?? [],
    extendedProperties: r.extendedProperties ?? {},
    iCalUId: r.iCalUId,
    isOnlineMeeting: r.isOnlineMeeting,
    onlineJoinUrl: r.onlineJoinUrl,
    lastModified: r.lastModified.toISOString(),
  };
}

export class MockCalendarAdapter implements CalendarAdapter {
  readonly mode = 'mock' as const;

  constructor(private readonly deps: AdapterDeps) {}

  private get db() {
    return this.deps.db;
  }

  /** Timestamp of a write (same-millisecond writes are handled by the delta token). */
  private stamp(): Date {
    return this.deps.now();
  }

  private async findRow(mailbox: string, eventId: string): Promise<Row | null> {
    const [row] = await this.db
      .select()
      .from(mockCalendarEvents)
      .where(and(eq(mockCalendarEvents.id, eventId), sql`lower(${mockCalendarEvents.mailbox}) = ${lower(mailbox)}`))
      .limit(1);
    return row ?? null;
  }

  async getSchedule(emails: string[], from: string, to: string): Promise<MailboxSchedule[]> {
    const wanted = [...new Set(emails.map(lower))];
    if (wanted.length === 0) return [];
    const rows = await this.db
      .select()
      .from(mockCalendarEvents)
      .where(
        and(
          inArray(sql<string>`lower(${mockCalendarEvents.mailbox})`, wanted),
          isNull(mockCalendarEvents.deletedAt),
          eq(mockCalendarEvents.isCancelled, false),
          ne(mockCalendarEvents.showAs, 'free'),
          lt(mockCalendarEvents.startAt, new Date(to)),
          gt(mockCalendarEvents.endAt, new Date(from)),
        ),
      );
    return emails.map((email) => ({
      email,
      busy: rows
        .filter((r) => lower(r.mailbox) === lower(email))
        .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
        // Like Graph getSchedule without details: no subjects of other people's meetings.
        .map((r) => ({ start: r.startAt.toISOString(), end: r.endAt.toISOString(), status: r.showAs, subject: null })),
      error: null,
    }));
  }

  async listEvents(mailbox: string, from: string, to: string): Promise<CalendarEvent[]> {
    const rows = await this.db
      .select()
      .from(mockCalendarEvents)
      .where(
        and(
          sql`lower(${mockCalendarEvents.mailbox}) = ${lower(mailbox)}`,
          isNull(mockCalendarEvents.deletedAt),
          lt(mockCalendarEvents.startAt, new Date(to)),
          gt(mockCalendarEvents.endAt, new Date(from)),
        ),
      )
      .orderBy(mockCalendarEvents.startAt);
    return rows.map(toCalendarEvent);
  }

  async getEvent(mailbox: string, eventId: string): Promise<CalendarEvent | null> {
    const row = await this.findRow(mailbox, eventId);
    return row && !row.deletedAt ? toCalendarEvent(row) : null;
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEvent> {
    const mailbox = lower(input.mailbox);
    const now = this.stamp();
    const id = randomUUID();
    const hasAttendees = (input.attendees ?? []).length > 0;
    const iCalUId = `mock-ical-${randomUUID()}`;
    const attendees: CalendarAttendee[] = hasAttendees
      ? [
          { email: mailbox, name: null, type: 'required', response: 'organizer' },
          ...(input.attendees ?? []).filter((a) => lower(a.email) !== mailbox).map((a) => ({ ...a, email: a.email.trim(), response: 'none' as const })),
        ]
      : [];
    const [row] = await this.db
      .insert(mockCalendarEvents)
      .values({
        id,
        mailbox,
        subject: input.subject,
        body: input.body ?? null,
        startAt: new Date(input.start),
        endAt: new Date(input.end),
        showAs: input.showAs ?? 'busy',
        categories: input.categories ?? [],
        organizer: mailbox,
        attendees,
        extendedProperties: input.extendedProperties ?? {},
        iCalUId,
        isOnlineMeeting: input.isOnlineMeeting ?? false,
        onlineJoinUrl: input.isOnlineMeeting ? `https://teams.microsoft.com/l/meetup-join/mock-${id}` : null,
        lastModified: now,
      })
      .returning();

    // Invitations land in the calendars of internal attendees (portal users) – like Exchange does.
    if (hasAttendees) {
      const others = attendees.filter((a) => a.response !== 'organizer').map((a) => lower(a.email));
      const internal = others.length
        ? await this.db.select({ email: users.email }).from(users).where(inArray(sql<string>`lower(${users.email})`, others))
        : [];
      if (internal.length) {
        await this.db.insert(mockCalendarEvents).values(
          internal.map((u) => ({
            id: randomUUID(),
            mailbox: lower(u.email),
            subject: input.subject,
            body: input.body ?? null,
            startAt: new Date(input.start),
            endAt: new Date(input.end),
            showAs: 'busy' as const,
            categories: [],
            organizer: mailbox,
            attendees,
            extendedProperties: {},
            iCalUId,
            isOnlineMeeting: row.isOnlineMeeting,
            onlineJoinUrl: row.onlineJoinUrl,
            lastModified: now,
          })),
        );
      }
    }
    return toCalendarEvent(row);
  }

  async updateEvent(mailbox: string, eventId: string, patch: Partial<CalendarEventInput>): Promise<CalendarEvent> {
    const row = await this.findRow(mailbox, eventId);
    if (!row || row.deletedAt) throw notFound('Termin nicht gefunden');
    const now = this.stamp();
    const set: Partial<Row> = { version: row.version + 1, lastModified: now };
    if (patch.subject !== undefined) set.subject = patch.subject;
    if (patch.body !== undefined) set.body = patch.body ?? null;
    if (patch.start !== undefined) set.startAt = new Date(patch.start);
    if (patch.end !== undefined) set.endAt = new Date(patch.end);
    if (patch.showAs !== undefined) set.showAs = patch.showAs;
    if (patch.categories !== undefined) set.categories = patch.categories;
    if (patch.extendedProperties !== undefined) set.extendedProperties = { ...row.extendedProperties, ...patch.extendedProperties };
    if (patch.attendees !== undefined) {
      const previous = new Map(row.attendees.map((a) => [lower(a.email), a.response]));
      set.attendees = [
        ...row.attendees.filter((a) => a.response === 'organizer'),
        ...patch.attendees
          .filter((a) => lower(a.email) !== lower(row.mailbox))
          .map((a) => ({ ...a, response: previous.get(lower(a.email)) ?? ('none' as const) })),
      ];
    }
    const [updated] = await this.db.update(mockCalendarEvents).set(set).where(eq(mockCalendarEvents.id, row.id)).returning();
    if (this.isOrganizerCopy(row)) {
      const propagate: PgUpdateSetSource<typeof mockCalendarEvents> = { lastModified: now, version: sql`${mockCalendarEvents.version} + 1` };
      if (set.subject !== undefined) propagate.subject = set.subject;
      if (set.startAt) propagate.startAt = set.startAt;
      if (set.endAt) propagate.endAt = set.endAt;
      if (set.attendees) propagate.attendees = set.attendees;
      await this.db
        .update(mockCalendarEvents)
        .set(propagate)
        .where(and(eq(mockCalendarEvents.iCalUId, row.iCalUId!), ne(mockCalendarEvents.id, row.id), isNull(mockCalendarEvents.deletedAt)));
    }
    return toCalendarEvent(updated);
  }

  async deleteEvent(mailbox: string, eventId: string): Promise<void> {
    const row = await this.findRow(mailbox, eventId);
    if (!row || row.deletedAt) return; // idempotent (jobs may retry)
    const now = this.stamp();
    await this.db
      .update(mockCalendarEvents)
      .set({ deletedAt: now, lastModified: now, version: row.version + 1 })
      .where(eq(mockCalendarEvents.id, row.id));
    if (this.isOrganizerCopy(row)) {
      // The organizer cancels → attendees' copies become «Abgesagt».
      await this.db
        .update(mockCalendarEvents)
        .set({ isCancelled: true, lastModified: now, version: sql`${mockCalendarEvents.version} + 1` })
        .where(and(eq(mockCalendarEvents.iCalUId, row.iCalUId!), ne(mockCalendarEvents.id, row.id), isNull(mockCalendarEvents.deletedAt)));
    }
  }

  async delta(mailbox: string, token: string | null): Promise<CalendarDelta> {
    const since = decodeToken(token);
    const rows = await this.db
      .select()
      .from(mockCalendarEvents)
      .where(
        and(
          sql`lower(${mockCalendarEvents.mailbox}) = ${lower(mailbox)}`,
          since ? gte(mockCalendarEvents.lastModified, new Date(since.t)) : isNull(mockCalendarEvents.deletedAt),
        ),
      )
      .orderBy(mockCalendarEvents.lastModified);
    const seen = new Set(since?.seen ?? []);
    const fresh = rows.filter((r) => !(r.lastModified.getTime() === since?.t && seen.has(`${r.id}:${r.version}`)));
    const maxT = rows.reduce((m, r) => Math.max(m, r.lastModified.getTime()), since?.t ?? 0);
    const atMax = rows.filter((r) => r.lastModified.getTime() === maxT).map((r) => `${r.id}:${r.version}`);
    const nextSeen = maxT === since?.t ? [...new Set([...(since?.seen ?? []), ...atMax])] : atMax;
    return {
      changed: fresh.filter((r) => !r.deletedAt).map(toCalendarEvent),
      deleted: since ? fresh.filter((r) => r.deletedAt).map((r) => r.id) : [],
      nextToken: encodeToken({ t: maxT, seen: nextSeen }),
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Simulation (demo + tests): what customers and colleagues do in Outlook
  // -------------------------------------------------------------------------------------------------------------------

  /** An attendee answers the invitation; the organizer's event (and copies) show the response. */
  async simulateResponse(mailbox: string, eventId: string, attendeeEmail: string, response: CalendarAttendee['response']): Promise<CalendarEvent> {
    const row = await this.findRow(mailbox, eventId);
    if (!row || row.deletedAt) throw notFound('Termin nicht gefunden');
    if (!row.attendees.some((a) => lower(a.email) === lower(attendeeEmail))) throw badRequest('Person ist nicht eingeladen');
    const attendees = row.attendees.map((a) => (lower(a.email) === lower(attendeeEmail) ? { ...a, response } : a));
    const now = this.stamp();
    const [updated] = await this.db
      .update(mockCalendarEvents)
      .set({ attendees, lastModified: now, version: row.version + 1 })
      .where(eq(mockCalendarEvents.id, row.id))
      .returning();
    if (row.iCalUId) {
      await this.db
        .update(mockCalendarEvents)
        .set({ attendees, lastModified: now, version: sql`${mockCalendarEvents.version} + 1` })
        .where(and(eq(mockCalendarEvents.iCalUId, row.iCalUId), ne(mockCalendarEvents.id, row.id), isNull(mockCalendarEvents.deletedAt)));
    }
    return toCalendarEvent(updated);
  }

  /** The organizer moves the meeting in Outlook. */
  async simulateMove(mailbox: string, eventId: string, newStart: string): Promise<CalendarEvent> {
    const row = await this.findRow(mailbox, eventId);
    if (!row || row.deletedAt) throw notFound('Termin nicht gefunden');
    const duration = row.endAt.getTime() - row.startAt.getTime();
    return this.updateEvent(mailbox, eventId, { start: newStart, end: new Date(new Date(newStart).getTime() + duration).toISOString() });
  }

  /** The organizer cancels / deletes the meeting in Outlook. */
  async simulateCancel(mailbox: string, eventId: string): Promise<void> {
    await this.deleteEvent(mailbox, eventId);
  }

  private isOrganizerCopy(row: Row): boolean {
    return !!row.iCalUId && !!row.organizer && lower(row.organizer) === lower(row.mailbox);
  }
}
