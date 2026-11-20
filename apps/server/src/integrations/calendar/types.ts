/**
 * Calendar adapter (Microsoft Graph): free/busy, events (meeting, blockers, briefing entries), delta query (6.6, 6.10, 6.11).
 * `mock` uses `mock_calendar_events`; `live` uses Graph (delegated via the coldcaller's delegate access, app permissions in jobs).
 */
import type { CalendarDelta, CalendarEvent, CalendarEventInput, IsoDateTime, MailboxSchedule } from '@sales-portal/shared';

export interface CalendarAdapter {
  readonly mode: 'mock' | 'live';
  /** Busy intervals per mailbox in [from, to). */
  getSchedule(emails: string[], from: IsoDateTime, to: IsoDateTime): Promise<MailboxSchedule[]>;
  listEvents(mailbox: string, from: IsoDateTime, to: IsoDateTime): Promise<CalendarEvent[]>;
  getEvent(mailbox: string, eventId: string): Promise<CalendarEvent | null>;
  /** Creates the event (Teams meeting if `isOnlineMeeting`) in `input.mailbox` and invites the attendees. */
  createEvent(input: CalendarEventInput): Promise<CalendarEvent>;
  updateEvent(mailbox: string, eventId: string, patch: Partial<CalendarEventInput>): Promise<CalendarEvent>;
  deleteEvent(mailbox: string, eventId: string): Promise<void>;
  /** Changes since `token` (null = initial sync). */
  delta(mailbox: string, token: string | null): Promise<CalendarDelta>;
}
