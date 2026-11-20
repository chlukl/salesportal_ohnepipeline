/**
 * Live calendar adapter (Microsoft Graph `${GRAPH_BASE_URL}`) – INTENT 6.6, 6.10, 6.11, 8.
 *
 * - User actions: delegated token of the acting user (Calendars.ReadWrite.Shared → Markus books in the Sales'
 *   calendar via delegate access, the Sales is organizer). Background jobs: app token (Calendars.ReadWrite),
 *   restricted to GRAPH_ALLOWED_MAILBOXES (+ RBAC for Applications in Exchange).
 * - Events carry categories («Kallysoft Erstgespräch» / «Kallysoft Briefing») and string extended properties in the
 *   portal's own property set (`KlsTerminId` …). Teams meeting via isOnlineMeeting + teamsForBusiness.
 * - `delta`: calendarView/delta; the returned `nextToken` is opaque (Graph deltaLink + window start) and is stored by
 *   the caller in `sync_state` (scheduling job, or `syncCalendarDelta` in integrations/live/calendarSync.ts). The
 *   adapter restarts the sequence itself after 7 days so the time window moves forward.
 * - Test redirect (ARCHITECTURE §5.11, same rule as the mail adapter): outside Prod – or whenever MAIL_TEST_RECIPIENT is
 *   set – external attendees (customers) are replaced by MAIL_TEST_RECIPIENT, so Exchange never sends an invitation,
 *   update or cancellation to a real customer. The original addresses are kept in a body note and in the extended
 *   property `KlsTestumleitung`; on read, the test recipient's response is mapped back onto them (declines stay testable).
 *   Outside Prod without MAIL_TEST_RECIPIENT, events with external attendees are refused. Outside Prod, updates/deletes
 *   of events that still list real external attendees (created elsewhere or before the redirect) are refused.
 */
import { createHash } from 'node:crypto';
import type { CalendarAttendee, CalendarDelta, CalendarEvent, CalendarEventInput, MailboxSchedule } from '@sales-portal/shared';
import type { AppConfig } from '../../config';
import { badRequest, forbidden } from '../../lib/errors';
import { getLiveRuntime, type LiveRuntime } from '../live/runtime';
import { GraphClient, GraphError, mailboxPath, normalizeMailbox, toAppError, UTC_PREFER } from '../live/graph';
import type { AdapterDeps } from '../types';
import type { CalendarAdapter } from './types';

/** Fixed property set GUID of the portal's named extended properties (never change – existing events use it). */
export const KLS_PROPERTY_SET = '{6b1d3c84-2f0e-4a55-9a7e-0c5f1d2b8e73}';
/**
 * Extended properties the portal reads on every event: Termin-ID of the booking and the role of linked entries
 * (`blocker` / `briefing`, see modules/scheduling/service.ts PROP_REF / PROP_ROLE). Others are written but not read back.
 */
export const KNOWN_EXTENDED_PROPERTIES = ['KlsTerminId', 'KlsRolle', 'KlsTestumleitung'];
/** Extended property with the original external attendees of a redirected test event (JSON, see redirectAttendees). */
export const TEST_REDIRECT_PROPERTY = 'KlsTestumleitung';
const MAX_REDIRECT_ORIGINALS = 20;
const PROP_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const EVENT_SELECT = [
  'id',
  'subject',
  'body',
  'start',
  'end',
  'showAs',
  'categories',
  'isCancelled',
  'organizer',
  'attendees',
  'iCalUId',
  'isOnlineMeeting',
  'onlineMeeting',
  'lastModifiedDateTime',
].join(',');

export function extendedPropertyId(name: string): string {
  if (!PROP_NAME_RE.test(name)) throw badRequest('Ungültiger Eigenschaftsname');
  return `String ${KLS_PROPERTY_SET} Name ${name}`;
}

/** `$expand` for the portal's extended properties. */
export function extendedPropertiesExpand(names: string[] = KNOWN_EXTENDED_PROPERTIES): string {
  const filter = names.map((n) => `id eq '${extendedPropertyId(n)}'`).join(' or ');
  return `singleValueExtendedProperties($filter=${filter})`;
}

interface GraphDateTime {
  dateTime: string;
  timeZone?: string;
}
interface GraphEvent {
  id: string;
  subject?: string | null;
  body?: { contentType?: string; content?: string } | null;
  start?: GraphDateTime;
  end?: GraphDateTime;
  showAs?: string;
  categories?: string[];
  isCancelled?: boolean;
  organizer?: { emailAddress?: { address?: string } };
  attendees?: { type?: string; emailAddress?: { address?: string; name?: string }; status?: { response?: string } }[];
  iCalUId?: string | null;
  isOnlineMeeting?: boolean;
  onlineMeeting?: { joinUrl?: string } | null;
  lastModifiedDateTime?: string;
  singleValueExtendedProperties?: { id: string; value: string }[];
  '@removed'?: { reason?: string };
}

/** Graph date-time (UTC because of the Prefer header) → ISO string. */
export function parseGraphDateTime(dt: GraphDateTime | undefined): string {
  if (!dt?.dateTime) return new Date(0).toISOString();
  const tz = (dt.timeZone ?? 'UTC').toUpperCase();
  const s = dt.dateTime;
  const hasOffset = /([zZ]|[+-]\d{2}:\d{2})$/.test(s);
  const t = Date.parse(hasOffset || tz !== 'UTC' ? s : `${s}Z`);
  return Number.isNaN(t) ? new Date(0).toISOString() : new Date(t).toISOString();
}

/** ISO → Graph `dateTimeTimeZone` in UTC. */
export function toGraphDateTime(isoValue: string): GraphDateTime {
  const t = Date.parse(isoValue);
  if (Number.isNaN(t)) throw badRequest('Ungültige Zeitangabe');
  return { dateTime: new Date(t).toISOString().replace(/Z$/, ''), timeZone: 'UTC' };
}

const SHOW_AS = new Set(['free', 'tentative', 'busy', 'oof', 'workingElsewhere']);
const RESPONSE: Record<string, CalendarAttendee['response']> = {
  none: 'none',
  notResponded: 'none',
  organizer: 'organizer',
  accepted: 'accepted',
  tentativelyAccepted: 'tentative',
  declined: 'declined',
};

export function mapGraphEvent(ev: GraphEvent, mailbox: string): CalendarEvent {
  const props: Record<string, string> = {};
  for (const p of ev.singleValueExtendedProperties ?? []) {
    const m = p.id.match(/Name\s+([A-Za-z][A-Za-z0-9_]*)$/);
    if (m && p.id.toLowerCase().includes(KLS_PROPERTY_SET.toLowerCase())) props[m[1]] = String(p.value);
  }
  const attendees: CalendarAttendee[] = (ev.attendees ?? []).map((a) => ({
    email: (a.emailAddress?.address ?? '').toLowerCase(),
    name: a.emailAddress?.name ?? null,
    type: a.type === 'optional' ? 'optional' : 'required',
    response: RESPONSE[a.status?.response ?? 'none'] ?? 'none',
  }));
  return {
    id: ev.id,
    mailbox,
    subject: ev.subject ?? '',
    body: ev.body?.content ?? null,
    start: parseGraphDateTime(ev.start),
    end: parseGraphDateTime(ev.end),
    showAs: (SHOW_AS.has(ev.showAs ?? '') ? ev.showAs : 'busy') as CalendarEvent['showAs'],
    categories: ev.categories ?? [],
    isCancelled: !!ev.isCancelled,
    organizer: ev.organizer?.emailAddress?.address?.toLowerCase() ?? null,
    attendees: unredirectAttendees(attendees, props[TEST_REDIRECT_PROPERTY]),
    extendedProperties: props,
    iCalUId: ev.iCalUId ?? null,
    isOnlineMeeting: !!ev.isOnlineMeeting,
    onlineJoinUrl: ev.onlineMeeting?.joinUrl ?? null,
    lastModified: ev.lastModifiedDateTime ? new Date(ev.lastModifiedDateTime).toISOString() : new Date(0).toISOString(),
  };
}

const lower = (s: string) => s.trim().toLowerCase();
const domainOf = (email: string) => lower(email).split('@')[1] ?? '';

/**
 * Test-redirect policy for one calendar (`mailbox` = organizer calendar). Internal = GRAPH_ALLOWED_MAILBOXES, their
 * domains and the organizer's domain; the test recipient itself is never "external". Everyone else is a customer.
 */
export function attendeePolicy(config: Pick<AppConfig, 'environmentLabel' | 'mailTestRecipient' | 'live'>, mailbox: string) {
  const testRecipient = config.mailTestRecipient ? lower(config.mailTestRecipient) : null;
  const internalMailboxes = new Set(config.live.allowedMailboxes.map(lower));
  const internalDomains = new Set([domainOf(mailbox), ...[...internalMailboxes].map(domainOf)].filter(Boolean));
  return {
    /** Same rule as LiveMailAdapter: outside Prod, or whenever a test recipient is configured. */
    redirect: config.environmentLabel !== 'Prod' || !!testRecipient,
    testRecipient,
    environmentLabel: config.environmentLabel,
    isExternal(email: string): boolean {
      const e = lower(email);
      return e !== testRecipient && !internalMailboxes.has(e) && !internalDomains.has(domainOf(e));
    },
  };
}
export type AttendeePolicy = ReturnType<typeof attendeePolicy>;

/**
 * Applies the test redirect to an event input: external attendees → test recipient, a note in the body (create, or
 * when the patch changes the body) and the originals in `KlsTestumleitung`. Throws 403 when a redirect is required but
 * no test recipient is configured. Inputs without external attendees are returned unchanged.
 */
export function redirectAttendees<T extends Partial<CalendarEventInput>>(input: T, policy: AttendeePolicy, mode: 'create' | 'update'): T {
  if (!policy.redirect || !input.attendees?.length) return input;
  const externals = input.attendees.filter((a) => policy.isExternal(a.email));
  if (!externals.length) return input;
  if (!policy.testRecipient) {
    throw forbidden('Ausserhalb der Produktion gehen Termineinladungen nur an die Testadresse (MAIL_TEST_RECIPIENT fehlt)');
  }
  const testRecipient = policy.testRecipient;
  const kept = input.attendees.filter((a) => !policy.isExternal(a.email) && lower(a.email) !== testRecipient);
  const original = externals.slice(0, MAX_REDIRECT_ORIGINALS).map((a) => ({ email: lower(a.email), name: a.name ?? null }));
  const note = `[Testumgebung ${policy.environmentLabel} – Einladung eigentlich an: ${original.map((a) => a.email).join(', ')}]`;
  const out: T = {
    ...input,
    attendees: [...kept, { email: testRecipient, name: 'Testadresse', type: 'required' as const }],
    extendedProperties: { ...(input.extendedProperties ?? {}), [TEST_REDIRECT_PROPERTY]: JSON.stringify({ to: testRecipient, original }) },
  };
  if (mode === 'create' || input.body !== undefined) out.body = input.body ? `${note}\n\n${input.body}` : note;
  return out;
}

/** Read side of the redirect: the test recipient's entry is shown as the original attendees (with its response). */
export function unredirectAttendees(attendees: CalendarAttendee[], raw: string | undefined): CalendarAttendee[] {
  if (!raw) return attendees;
  let info: { to?: unknown; original?: unknown };
  try {
    info = JSON.parse(raw) as typeof info;
  } catch {
    return attendees;
  }
  const to = typeof info.to === 'string' ? lower(info.to) : null;
  const idx = to ? attendees.findIndex((a) => a.email === to) : -1;
  if (idx < 0 || !Array.isArray(info.original)) return attendees;
  const stand = attendees[idx];
  const mapped: CalendarAttendee[] = (info.original as unknown[])
    .filter((o): o is { email: string; name?: unknown } => !!o && typeof (o as { email?: unknown }).email === 'string')
    .slice(0, MAX_REDIRECT_ORIGINALS)
    .map((o) => ({ email: lower(o.email), name: typeof o.name === 'string' ? o.name : null, type: stand.type, response: stand.response }));
  return [...attendees.slice(0, idx), ...mapped, ...attendees.slice(idx + 1)];
}

/** Graph event body for create (full) or update (only given fields). */
export function eventPayload(input: Partial<CalendarEventInput>, mode: 'create' | 'update'): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.subject !== undefined) body.subject = input.subject.slice(0, 255);
  if (input.body !== undefined) body.body = { contentType: 'text', content: input.body ?? '' };
  if (input.start !== undefined) body.start = toGraphDateTime(input.start);
  if (input.end !== undefined) body.end = toGraphDateTime(input.end);
  if (input.start !== undefined && input.end !== undefined && Date.parse(input.end) <= Date.parse(input.start)) {
    throw badRequest('Ende muss nach dem Beginn liegen');
  }
  if (input.showAs !== undefined) body.showAs = input.showAs;
  if (input.categories !== undefined) body.categories = input.categories.map((c) => c.slice(0, 255));
  if (input.attendees !== undefined) {
    body.attendees = input.attendees.map((a) => ({
      emailAddress: { address: normalizeMailbox(a.email), ...(a.name ? { name: a.name } : {}) },
      type: a.type,
    }));
  }
  if (input.isOnlineMeeting !== undefined) {
    body.isOnlineMeeting = input.isOnlineMeeting;
    if (input.isOnlineMeeting) body.onlineMeetingProvider = 'teamsForBusiness';
  }
  if (input.extendedProperties !== undefined) {
    body.singleValueExtendedProperties = Object.entries(input.extendedProperties).map(([name, value]) => ({
      id: extendedPropertyId(name),
      value: String(value),
    }));
  }
  if (mode === 'create') {
    // Idempotency key: a retried POST with the same transactionId does not create a second event.
    const key = JSON.stringify([input.mailbox, input.subject, input.start, input.end, input.extendedProperties ?? {}]);
    body.transactionId = createHash('sha256').update(key).digest('hex').slice(0, 36);
  }
  return body;
}

const SCHEDULE_STATUS: Record<string, MailboxSchedule['busy'][number]['status']> = {
  busy: 'busy',
  tentative: 'tentative',
  oof: 'oof',
  workingElsewhere: 'workingElsewhere',
  free: 'free',
};

export class LiveCalendarAdapter implements CalendarAdapter {
  readonly mode = 'live' as const;
  private readonly rt: LiveRuntime;
  private readonly graph: GraphClient;
  /** For Graph $batch retry waits (tests inject a no-op). */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  constructor(
    private readonly deps: AdapterDeps,
    runtime?: LiveRuntime,
  ) {
    this.rt = runtime ?? getLiveRuntime(deps.config, deps.log);
    this.graph = new GraphClient({
      baseUrl: deps.config.graphBaseUrl,
      http: this.rt.http,
      getToken: () => this.rt.tokens.getToken('graph', deps.auth, deps.db),
      log: deps.log,
    });
  }

  private path(mailbox: string): string {
    return mailboxPath(this.deps.config.live, this.deps.auth, mailbox);
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toAppError(err);
    }
  }

  /**
   * Outside Prod: changing or cancelling an event that still lists real customers would make Exchange mail them, so
   * such events (created outside the portal or before the redirect) are refused. Missing event (404) → no guard.
   */
  private async assertNoRealExternals(mailbox: string, eventId: string, policy: AttendeePolicy): Promise<void> {
    if (!policy.redirect) return;
    let ev: Pick<GraphEvent, 'attendees'>;
    try {
      ev = await this.graph.request<Pick<GraphEvent, 'attendees'>>({
        method: 'GET',
        path: `${this.path(mailbox)}/events/${encodeURIComponent(eventId)}?$select=attendees`,
      });
    } catch (err) {
      if (err instanceof GraphError && err.status === 404) return;
      throw toAppError(err);
    }
    if ((ev.attendees ?? []).some((a) => !!a.emailAddress?.address && policy.isExternal(a.emailAddress.address))) {
      throw forbidden(
        'Dieser Termin enthält echte Kundenadressen – ausserhalb der Produktion wird er nicht geändert oder abgesagt (der Kunde bekäme sonst eine Mail)',
      );
    }
  }

  async getSchedule(emails: string[], from: string, to: string): Promise<MailboxSchedule[]> {
    const live = this.deps.config.live;
    const list = [...new Set(emails.map((e) => e.trim().toLowerCase()))];
    const out = new Map<string, MailboxSchedule>();
    const permitted: string[] = [];
    for (const e of list) {
      try {
        normalizeMailbox(e);
        if (live.allowedMailboxes.length && !live.allowedMailboxes.includes(e)) throw new Error('not allowed');
        permitted.push(e);
      } catch {
        out.set(e, { email: e, busy: [], error: 'Postfach nicht freigegeben' });
      }
    }
    if (permitted.length) {
      // getSchedule runs in the context of a mailbox: delegated → /me, app → first permitted mailbox.
      const basePath = this.deps.auth.kind === 'user' ? '/me' : this.path(permitted[0]);
      for (let i = 0; i < permitted.length; i += 20) {
        const chunkEmails = permitted.slice(i, i + 20);
        const res = await this.call(() =>
          this.graph.request<{ value?: { scheduleId: string; scheduleItems?: { status?: string; start?: GraphDateTime; end?: GraphDateTime; subject?: string }[]; error?: { message?: string } }[] }>({
            method: 'POST',
            path: `${basePath}/calendar/getSchedule`,
            headers: { Prefer: UTC_PREFER },
            body: { schedules: chunkEmails, startTime: toGraphDateTime(from), endTime: toGraphDateTime(to), availabilityViewInterval: 15 },
            retry: 'idempotent', // read-only action
          }),
        );
        for (const s of res.value ?? []) {
          const email = s.scheduleId.toLowerCase();
          out.set(email, {
            email,
            busy: (s.scheduleItems ?? [])
              .map((it) => ({
                start: parseGraphDateTime(it.start),
                end: parseGraphDateTime(it.end),
                status: SCHEDULE_STATUS[it.status ?? 'busy'] ?? 'busy',
                subject: it.subject ?? null,
              }))
              .filter((b) => b.status !== 'free'),
            error: s.error ? 'Kalender nicht lesbar' : null,
          });
        }
        for (const e of chunkEmails) if (!out.has(e)) out.set(e, { email: e, busy: [], error: 'Kalender nicht lesbar' });
      }
    }
    return list.map((e) => out.get(e) ?? { email: e, busy: [], error: 'Kalender nicht lesbar' });
  }

  async listEvents(mailbox: string, from: string, to: string): Promise<CalendarEvent[]> {
    const m = normalizeMailbox(mailbox);
    if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw badRequest('Ungültiger Zeitraum');
    const qs = new URLSearchParams({
      startDateTime: new Date(Date.parse(from)).toISOString(),
      endDateTime: new Date(Date.parse(to)).toISOString(),
      $select: EVENT_SELECT,
      $expand: extendedPropertiesExpand(),
      $top: '100',
      $orderby: 'start/dateTime',
    });
    const events = await this.call(() =>
      this.graph.list<GraphEvent>(`${this.path(m)}/calendarView?${qs.toString()}`, { Prefer: `${UTC_PREFER}, outlook.body-content-type="text"` }),
    );
    return events.map((e) => mapGraphEvent(e, m));
  }

  async getEvent(mailbox: string, eventId: string): Promise<CalendarEvent | null> {
    const m = normalizeMailbox(mailbox);
    try {
      const ev = await this.graph.request<GraphEvent>({
        method: 'GET',
        path: `${this.path(m)}/events/${encodeURIComponent(eventId)}?$select=${EVENT_SELECT}&$expand=${encodeURIComponent(extendedPropertiesExpand())}`,
        headers: { Prefer: `${UTC_PREFER}, outlook.body-content-type="text"` },
      });
      return mapGraphEvent(ev, m);
    } catch (err) {
      if (err instanceof GraphError && err.status === 404) return null;
      throw toAppError(err);
    }
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEvent> {
    const m = normalizeMailbox(input.mailbox);
    const body = eventPayload(redirectAttendees(input, attendeePolicy(this.deps.config, m), 'create'), 'create');
    const created = await this.call(() =>
      this.graph.request<GraphEvent>({
        method: 'POST',
        path: `${this.path(m)}/events`,
        headers: { Prefer: UTC_PREFER },
        body,
        retry: 'idempotent', // safe because of transactionId
      }),
    );
    // The create response does not include the extended properties; read the event back.
    return (await this.getEvent(m, created.id)) ?? mapGraphEvent(created, m);
  }

  async updateEvent(mailbox: string, eventId: string, patch: Partial<CalendarEventInput>): Promise<CalendarEvent> {
    const m = normalizeMailbox(mailbox);
    const policy = attendeePolicy(this.deps.config, m);
    const body = eventPayload(redirectAttendees(patch, policy, 'update'), 'update');
    await this.assertNoRealExternals(m, eventId, policy);
    await this.call(() =>
      this.graph.request<GraphEvent>({
        method: 'PATCH',
        path: `${this.path(m)}/events/${encodeURIComponent(eventId)}`,
        headers: { Prefer: UTC_PREFER },
        body,
        retry: 'idempotent',
      }),
    );
    const ev = await this.getEvent(m, eventId);
    if (!ev) throw toAppError(new GraphError(404, 'ErrorItemNotFound'));
    return ev;
  }

  async deleteEvent(mailbox: string, eventId: string): Promise<void> {
    const m = normalizeMailbox(mailbox);
    await this.assertNoRealExternals(m, eventId, attendeePolicy(this.deps.config, m));
    try {
      await this.graph.request({ method: 'DELETE', path: `${this.path(m)}/events/${encodeURIComponent(eventId)}`, retry: 'idempotent' });
    } catch (err) {
      if (err instanceof GraphError && err.status === 404) return; // already gone
      throw toAppError(err);
    }
  }

  /**
   * calendarView delta for the window [now - GRAPH_DELTA_PAST_DAYS, now + GRAPH_DELTA_FUTURE_DAYS].
   * `token` = previous deltaLink (null = initial sync). Expired/invalid delta state (410) → full resync.
   * Changed events are re-read via $batch to include the extended properties (delta does not return them).
   */
  async delta(mailbox: string, token: string | null): Promise<CalendarDelta> {
    const m = normalizeMailbox(mailbox);
    const base = this.path(m);
    const now = this.deps.now().getTime();
    const { deltaPastDays, deltaFutureDays } = this.deps.config.live;
    const initial = () =>
      `${base}/calendarView/delta?${new URLSearchParams({
        startDateTime: new Date(now - deltaPastDays * 86_400_000).toISOString(),
        endDateTime: new Date(now + deltaFutureDays * 86_400_000).toISOString(),
      }).toString()}`;

    const headers = { Prefer: `${UTC_PREFER}, odata.maxpagesize=50` };
    const run = async (start: string) => {
      const items: GraphEvent[] = [];
      let next: string | null = start;
      let deltaLink: string | null = null;
      for (let pages = 0; next && pages < 500; pages++) {
        const page: { value?: GraphEvent[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string } = await this.graph.request({
          method: 'GET',
          path: next,
          headers,
        });
        items.push(...(page.value ?? []));
        deltaLink = page['@odata.deltaLink'] ?? null;
        next = page['@odata.nextLink'] ?? null;
      }
      if (!deltaLink) throw new GraphError(502, 'missing_delta_link');
      return { items, deltaLink };
    };

    // The token is opaque for callers: `<deltaLink>#sp-window=<window start>`. The window is fixed per delta sequence,
    // so after WINDOW_MAX_AGE_MS a new initial sync moves it forward (callers get every event again → must be idempotent).
    const parsed = parseDeltaToken(token, now);
    const resume = parsed && now - parsed.windowStart <= WINDOW_MAX_AGE_MS && parsed.windowStart <= now + 60_000 ? parsed : null;
    const restart = !resume;
    let windowStart = resume ? resume.windowStart : now;

    let result: { items: GraphEvent[]; deltaLink: string };
    try {
      result = await run(resume ? resume.link : initial());
    } catch (err) {
      const resync = err instanceof GraphError && (err.status === 410 || /syncstate|resync/i.test(err.code ?? '') || err.code === 'foreign_link');
      if (restart || !resync) throw toAppError(err);
      windowStart = now;
      this.deps.log.warn({ status: err.status }, 'calendar delta state invalid, full resync');
      try {
        result = await run(initial());
      } catch (err2) {
        throw toAppError(err2);
      }
    }

    const deleted = new Set<string>();
    const changedIds: string[] = [];
    for (const it of result.items) {
      if (it['@removed']) deleted.add(it.id);
      else if (!changedIds.includes(it.id)) changedIds.push(it.id);
    }
    const changed: CalendarEvent[] = [];
    if (changedIds.length) {
      const relBase = `${base}`;
      const responses = await this.call(() =>
        this.graph.batch(
          changedIds.map((id, i) => ({
            id: String(i),
            method: 'GET' as const,
            url: `${relBase}/events/${encodeURIComponent(id)}?$select=${EVENT_SELECT}&$expand=${encodeURIComponent(extendedPropertiesExpand())}`,
            headers: { Prefer: `${UTC_PREFER}, outlook.body-content-type="text"` },
          })),
          this.sleep,
        ),
      );
      changedIds.forEach((id, i) => {
        const r = responses.get(String(i));
        if (!r) return;
        if (r.status === 404) deleted.add(id);
        else if (r.status === 200 && r.body) changed.push(mapGraphEvent(r.body as GraphEvent, m));
        else {
          // Fall back to the delta payload (without extended properties) rather than losing the change.
          const raw = result.items.find((x) => x.id === id);
          if (raw) changed.push(mapGraphEvent(raw, m));
        }
      });
    }
    return { changed, deleted: [...deleted], nextToken: `${result.deltaLink}${WINDOW_MARK}${new Date(windowStart).toISOString()}` };
  }
}

const WINDOW_MARK = '#sp-window=';
/** A delta sequence is restarted after 7 days so the [past, future] window moves with time. */
export const WINDOW_MAX_AGE_MS = 7 * 86_400_000;

/** Split our opaque delta token into the Graph deltaLink and the window start (tokens without mark: window = now). */
export function parseDeltaToken(token: string | null, now: number): { link: string; windowStart: number } | null {
  if (!token) return null;
  const i = token.lastIndexOf(WINDOW_MARK);
  if (i < 0) return { link: token, windowStart: now };
  const start = Date.parse(token.slice(i + WINDOW_MARK.length));
  return { link: token.slice(0, i), windowStart: Number.isNaN(start) ? 0 : start };
}
