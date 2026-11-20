import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config';
import type { DbHandle } from '../src/db/client';
import {
  attendeePolicy,
  KLS_PROPERTY_SET,
  LiveCalendarAdapter,
  parseGraphDateTime,
  redirectAttendees,
  TEST_REDIRECT_PROPERTY,
} from '../src/integrations/calendar/live';
import { loadDeltaToken, syncCalendarDelta } from '../src/integrations/live/calendarSync';
import { MailboxNotAllowedError } from '../src/integrations/live/errors';
import { LiveMailAdapter } from '../src/integrations/mail/live';
import type { AdapterAuth } from '../src/integrations/types';
import { closeTestDb, deps, fakeFetch, GRAPH, liveConfig, testDb, testRuntime, tokenRoute, type Route } from './live-helpers';

const NOW = new Date('2026-11-20T09:00:00Z');
const MARKUS: AdapterAuth = { kind: 'user', userId: 'u-markus', email: 'Markus@kallysoft.ch', sessionIdHash: null };
const SYSTEM: AdapterAuth = { kind: 'system' };
const PROP = `String ${KLS_PROPERTY_SET} Name KlsTerminId`;

let config: AppConfig;
let handle: DbHandle;

beforeAll(async () => {
  config = liveConfig();
  handle = await testDb(config);
});
afterAll(async () => {
  await closeTestDb();
});

function graph(routes: Route[], cfg = config) {
  const ff = fakeFetch([tokenRoute(), ...routes]);
  const sleeps: number[] = [];
  return { ff, sleeps, rt: testRuntime(cfg, ff.fetch, sleeps) };
}
const rel = (url: string) => decodeURIComponent(url.replace(GRAPH, ''));

const graphEvent = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  subject: 'Vorstellung der Kallysoft Informatik AG als KI-Spezialist – Muster AG',
  body: { contentType: 'text', content: 'Hallo' },
  start: { dateTime: '2026-11-25T09:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-11-25T09:30:00.0000000', timeZone: 'UTC' },
  showAs: 'busy',
  categories: ['Kallysoft Erstgespräch'],
  organizer: { emailAddress: { address: 'Manuel@kallysoft.ch' } },
  attendees: [
    { type: 'required', emailAddress: { address: 'kunde@muster.ch', name: 'Anna Muster' }, status: { response: 'declined' } },
    { type: 'required', emailAddress: { address: 'nico@kallysoft.ch' }, status: { response: 'tentativelyAccepted' } },
  ],
  iCalUId: 'ical-1',
  isOnlineMeeting: true,
  onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/x' },
  lastModifiedDateTime: '2026-11-20T08:00:00Z',
  singleValueExtendedProperties: [{ id: PROP, value: 'T-2026-001' }],
  ...extra,
});

describe('live calendar – free/busy and events', () => {
  it('getSchedule: delegated via /me, UTC times, free slots dropped, non-allowed mailboxes not queried', async () => {
    const { ff, rt } = graph([
      (req) =>
        req.url.endsWith('/me/calendar/getSchedule')
          ? {
              body: {
                value: [
                  {
                    scheduleId: 'Manuel@kallysoft.ch',
                    scheduleItems: [
                      { status: 'busy', start: { dateTime: '2026-11-25T09:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-25T10:00:00.0000000', timeZone: 'UTC' } },
                      { status: 'free', start: { dateTime: '2026-11-25T11:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-25T12:00:00.0000000', timeZone: 'UTC' } },
                    ],
                  },
                  { scheduleId: 'nico@kallysoft.ch', error: { message: 'ErrorMailboxNotFound' } },
                ],
              },
            }
          : undefined,
    ]);
    const cal = new LiveCalendarAdapter(deps(config, handle.db, MARKUS, NOW), rt);
    const res = await cal.getSchedule(['manuel@kallysoft.ch', 'nico@kallysoft.ch', 'fremd@example.com'], '2026-11-25T00:00:00Z', '2026-11-26T00:00:00Z');
    const req = ff.calls.find((c) => c.url.includes('getSchedule'))!;
    expect(req.headers.prefer).toBe('outlook.timezone="UTC"');
    const body = JSON.parse(req.body);
    expect(body.schedules).toEqual(['manuel@kallysoft.ch', 'nico@kallysoft.ch']);
    expect(body.startTime).toEqual({ dateTime: '2026-11-25T00:00:00.000', timeZone: 'UTC' });
    expect(res).toEqual([
      { email: 'manuel@kallysoft.ch', busy: [{ start: '2026-11-25T09:00:00.000Z', end: '2026-11-25T10:00:00.000Z', status: 'busy', subject: null }], error: null },
      { email: 'nico@kallysoft.ch', busy: [], error: 'Kalender nicht lesbar' },
      { email: 'fremd@example.com', busy: [], error: 'Postfach nicht freigegeben' },
    ]);
  });

  it('createEvent (Prod): Teams meeting with category, Termin-ID extended property and idempotency key, in the Sales calendar via delegation', async () => {
    const prod = liveConfig({ ENVIRONMENT_LABEL: 'Prod', MAIL_TEST_RECIPIENT: '' });
    const { ff, rt } = graph(
      [
        (req) => (req.method === 'POST' && rel(req.url) === '/users/manuel@kallysoft.ch/events' ? { status: 201, body: { id: 'EV1' } } : undefined),
        (req) => (req.method === 'GET' && rel(req.url).startsWith('/users/manuel@kallysoft.ch/events/EV1?') ? { body: graphEvent('EV1') } : undefined),
      ],
      prod,
    );
    const cal = new LiveCalendarAdapter(deps(prod, handle.db, MARKUS, NOW), rt);
    const ev = await cal.createEvent({
      mailbox: 'Manuel@kallysoft.ch',
      subject: 'Vorstellung der Kallysoft Informatik AG als KI-Spezialist – Muster AG',
      body: 'Hallo',
      start: '2026-11-25T09:00:00Z',
      end: '2026-11-25T09:30:00Z',
      categories: ['Kallysoft Erstgespräch'],
      attendees: [{ email: 'kunde@muster.ch', name: 'Anna Muster', type: 'required' }],
      extendedProperties: { KlsTerminId: 'T-2026-001' },
      isOnlineMeeting: true,
    });
    const post = ff.calls.find((c) => c.method === 'POST' && c.url.endsWith('/events'))!;
    const body = JSON.parse(post.body);
    expect(body).toMatchObject({
      categories: ['Kallysoft Erstgespräch'],
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
      start: { dateTime: '2026-11-25T09:00:00.000', timeZone: 'UTC' },
      singleValueExtendedProperties: [{ id: PROP, value: 'T-2026-001' }],
      attendees: [{ emailAddress: { address: 'kunde@muster.ch', name: 'Anna Muster' }, type: 'required' }],
    });
    expect(body.transactionId).toMatch(/^[0-9a-f]{36}$/);
    expect(decodeURIComponent(ff.calls.at(-1)!.url)).toContain(`$expand=singleValueExtendedProperties($filter=id eq '${PROP}'`);
    expect(ev).toMatchObject({
      id: 'EV1',
      mailbox: 'manuel@kallysoft.ch',
      start: '2026-11-25T09:00:00.000Z',
      organizer: 'manuel@kallysoft.ch',
      extendedProperties: { KlsTerminId: 'T-2026-001' },
      onlineJoinUrl: 'https://teams.microsoft.com/l/meetup-join/x',
      isOnlineMeeting: true,
    });
    expect(ev.attendees.map((a) => a.response)).toEqual(['declined', 'tentative']);
  });

  it('refuses mailboxes outside GRAPH_ALLOWED_MAILBOXES (and app-only access without the list)', async () => {
    const { ff, rt } = graph([]);
    const cal = new LiveCalendarAdapter(deps(config, handle.db, SYSTEM, NOW), rt);
    await expect(cal.listEvents('ceo@kallysoft.ch', '2026-11-20T00:00:00Z', '2026-11-21T00:00:00Z')).rejects.toBeInstanceOf(MailboxNotAllowedError);
    await expect(cal.deleteEvent("x'/../../users@evil", 'EV1')).rejects.toBeInstanceOf(MailboxNotAllowedError);

    const open = liveConfig({ GRAPH_ALLOWED_MAILBOXES: '' });
    const g2 = graph([], open);
    const appCal = new LiveCalendarAdapter(deps(open, handle.db, SYSTEM, NOW), g2.rt);
    await expect(appCal.getEvent('manuel@kallysoft.ch', 'EV1')).rejects.toMatchObject({ statusCode: 403, code: 'mailbox_not_allowed' });
    expect([...ff.calls, ...g2.ff.calls].filter((c) => c.url.startsWith(GRAPH))).toHaveLength(0);
  });

  it('deleteEvent is idempotent (404 = already gone); getEvent 404 → null', async () => {
    const { rt } = graph([(req) => (req.url.startsWith(GRAPH) ? { status: 404, body: { error: { code: 'ErrorItemNotFound' } } } : undefined)]);
    const cal = new LiveCalendarAdapter(deps(config, handle.db, SYSTEM, NOW), rt);
    await expect(cal.deleteEvent('manuel@kallysoft.ch', 'EV1')).resolves.toBeUndefined();
    await expect(cal.getEvent('manuel@kallysoft.ch', 'EV1')).resolves.toBeNull();
  });

  it('parses Graph date-times as UTC', () => {
    expect(parseGraphDateTime({ dateTime: '2026-11-25T09:00:00.0000000', timeZone: 'UTC' })).toBe('2026-11-25T09:00:00.000Z');
    expect(parseGraphDateTime({ dateTime: '2026-11-25T09:00:00Z' })).toBe('2026-11-25T09:00:00.000Z');
  });
});

describe('live calendar – no invitations to real customers outside Prod (§5.11)', () => {
  const REDIRECT_PROP = `String ${KLS_PROPERTY_SET} Name ${TEST_REDIRECT_PROPERTY}`;
  const bookingInput = {
    mailbox: 'manuel@kallysoft.ch',
    subject: 'Vorstellung – Muster AG',
    body: 'Hallo',
    start: '2026-11-25T09:00:00Z',
    end: '2026-11-25T09:30:00Z',
    attendees: [
      { email: 'nico@kallysoft.ch', name: 'Nico', type: 'required' as const },
      { email: 'Kunde@Muster.ch', name: 'Anna Muster', type: 'required' as const },
      { email: 'chef@muster.ch', name: null, type: 'required' as const },
    ],
    extendedProperties: { KlsTerminId: 'T-2026-009' },
    isOnlineMeeting: true,
  };
  const redirectedEvent = (response: string) =>
    graphEvent('EV9', {
      attendees: [
        { type: 'required', emailAddress: { address: 'nico@kallysoft.ch' }, status: { response: 'accepted' } },
        { type: 'required', emailAddress: { address: 'test@kallysoft.ch', name: 'Testadresse' }, status: { response } },
      ],
      singleValueExtendedProperties: [
        { id: PROP, value: 'T-2026-009' },
        { id: REDIRECT_PROP, value: JSON.stringify({ to: 'test@kallysoft.ch', original: [{ email: 'kunde@muster.ch', name: 'Anna Muster' }, { email: 'chef@muster.ch', name: null }] }) },
      ],
    });

  it('Demo/Sandbox: external attendees are replaced by MAIL_TEST_RECIPIENT; internal ones stay; originals noted', async () => {
    const sandbox = liveConfig({ ENVIRONMENT_LABEL: 'Sandbox' });
    const { ff, rt } = graph(
      [
        (req) => (req.method === 'POST' && rel(req.url) === '/users/manuel@kallysoft.ch/events' ? { status: 201, body: { id: 'EV9' } } : undefined),
        (req) => (req.method === 'GET' && rel(req.url).startsWith('/users/manuel@kallysoft.ch/events/EV9?') ? { body: redirectedEvent('declined') } : undefined),
      ],
      sandbox,
    );
    const cal = new LiveCalendarAdapter(deps(sandbox, handle.db, MARKUS, NOW), rt);
    const ev = await cal.createEvent(bookingInput);
    const body = JSON.parse(ff.calls.find((c) => c.method === 'POST' && c.url.endsWith('/events'))!.body);
    expect(body.attendees.map((a: { emailAddress: { address: string } }) => a.emailAddress.address)).toEqual(['nico@kallysoft.ch', 'test@kallysoft.ch']);
    expect(JSON.stringify(body.attendees)).not.toMatch(/muster\.ch/i);
    expect(body.body.content).toMatch(/^\[Testumgebung Sandbox – Einladung eigentlich an: kunde@muster\.ch, chef@muster\.ch\]\n\nHallo$/);
    const redirect = body.singleValueExtendedProperties.find((p: { id: string }) => p.id === REDIRECT_PROP);
    expect(JSON.parse(redirect.value)).toEqual({ to: 'test@kallysoft.ch', original: [{ email: 'kunde@muster.ch', name: 'Anna Muster' }, { email: 'chef@muster.ch', name: null }] });
    // Read side: the test recipient's answer counts for the original customers (decline stays testable).
    expect(ev.attendees.map((a) => [a.email, a.response])).toEqual([
      ['nico@kallysoft.ch', 'accepted'],
      ['kunde@muster.ch', 'declined'],
      ['chef@muster.ch', 'declined'],
    ]);
  });

  it('Sandbox without MAIL_TEST_RECIPIENT: events with customers are refused, internal-only events still work', async () => {
    const sandbox = liveConfig({ ENVIRONMENT_LABEL: 'Sandbox', MAIL_TEST_RECIPIENT: '' });
    const { ff, rt } = graph(
      [
        (req) => (req.method === 'POST' && req.url.endsWith('/events') ? { status: 201, body: { id: 'EV10' } } : undefined),
        (req) => (req.method === 'GET' && rel(req.url).includes('/events/EV10?') ? { body: graphEvent('EV10', { attendees: [] }) } : undefined),
      ],
      sandbox,
    );
    const cal = new LiveCalendarAdapter(deps(sandbox, handle.db, MARKUS, NOW), rt);
    await expect(cal.createEvent(bookingInput)).rejects.toMatchObject({ statusCode: 403 });
    expect(ff.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/events'))).toHaveLength(0);
    await cal.createEvent({ ...bookingInput, attendees: [bookingInput.attendees[0]], body: 'Briefing' });
    const body = JSON.parse(ff.calls.find((c) => c.method === 'POST' && c.url.endsWith('/events'))!.body);
    expect(body.attendees).toEqual([{ emailAddress: { address: 'nico@kallysoft.ch', name: 'Nico' }, type: 'required' }]);
    expect(body.body.content).toBe('Briefing');
  });

  it('Sandbox: moving/cancelling an event that still lists real customers is refused; redirected events are fine', async () => {
    const sandbox = liveConfig({ ENVIRONMENT_LABEL: 'Sandbox' });
    const raw: Record<string, unknown> = {
      LEGACY: { attendees: [{ emailAddress: { address: 'kunde@muster.ch' } }, { emailAddress: { address: 'nico@kallysoft.ch' } }] },
      EV9: { attendees: [{ emailAddress: { address: 'nico@kallysoft.ch' } }, { emailAddress: { address: 'test@kallysoft.ch' } }] },
    };
    const { ff, rt } = graph(
      [
        (req) => {
          const m = rel(req.url).match(/^\/users\/manuel@kallysoft\.ch\/events\/([A-Z0-9]+)\?\$select=attendees$/);
          return req.method === 'GET' && m ? { body: raw[m[1]] } : undefined;
        },
        (req) => (req.method === 'GET' && rel(req.url).includes('/events/EV9?') ? { body: redirectedEvent('accepted') } : undefined),
        (req) => (req.method === 'PATCH' || req.method === 'DELETE' ? { status: req.method === 'DELETE' ? 204 : 200, body: {} } : undefined),
      ],
      sandbox,
    );
    const cal = new LiveCalendarAdapter(deps(sandbox, handle.db, SYSTEM, NOW), rt);
    const move = { start: '2026-11-26T09:00:00Z', end: '2026-11-26T09:30:00Z' };
    await expect(cal.updateEvent('manuel@kallysoft.ch', 'LEGACY', move)).rejects.toMatchObject({ statusCode: 403 });
    await expect(cal.deleteEvent('manuel@kallysoft.ch', 'LEGACY')).rejects.toMatchObject({ statusCode: 403 });
    expect(ff.calls.filter((c) => c.method === 'PATCH' || c.method === 'DELETE')).toHaveLength(0);

    await cal.updateEvent('manuel@kallysoft.ch', 'EV9', move);
    await cal.deleteEvent('manuel@kallysoft.ch', 'EV9');
    expect(ff.calls.filter((c) => c.method === 'PATCH' || c.method === 'DELETE').map((c) => c.method)).toEqual(['PATCH', 'DELETE']);

    // A patch that sets attendees is redirected the same way as a create.
    await cal.updateEvent('manuel@kallysoft.ch', 'EV9', { attendees: [{ email: 'neu@muster.ch', type: 'required' }] });
    const patch = JSON.parse(ff.calls.filter((c) => c.method === 'PATCH').at(-1)!.body);
    expect(patch.attendees).toEqual([{ emailAddress: { address: 'test@kallysoft.ch', name: 'Testadresse' }, type: 'required' }]);
    expect(patch.body).toBeUndefined();
  });

  it('Prod without test recipient: real attendees, no extra guard request before update/delete', async () => {
    const prod = liveConfig({ ENVIRONMENT_LABEL: 'Prod', MAIL_TEST_RECIPIENT: '' });
    const { ff, rt } = graph([(req) => (req.method === 'DELETE' ? { status: 204 } : undefined)], prod);
    await new LiveCalendarAdapter(deps(prod, handle.db, SYSTEM, NOW), rt).deleteEvent('manuel@kallysoft.ch', 'EV1');
    expect(ff.calls.filter((c) => c.url.startsWith(GRAPH)).map((c) => c.method)).toEqual(['DELETE']);
    expect(redirectAttendees({ attendees: bookingInput.attendees }, attendeePolicy(prod, 'manuel@kallysoft.ch'), 'create').attendees).toEqual(bookingInput.attendees);
  });

  it('policy: organizer domain and allowed mailboxes are internal; Prod with a test recipient still redirects', () => {
    const p = attendeePolicy(liveConfig({ ENVIRONMENT_LABEL: 'Prod' }), 'manuel@kallysoft.ch');
    expect(p.redirect).toBe(true);
    expect(p.isExternal('Neu@Kallysoft.ch')).toBe(false);
    expect(p.isExternal('test@kallysoft.ch')).toBe(false);
    expect(p.isExternal('kunde@muster.ch')).toBe(true);
    expect(p.isExternal('kunde@kallysoft.ch.evil.com')).toBe(true);
  });
});

describe('live calendar – delta query', () => {
  const DELTA_LINK = `${GRAPH}/users/manuel@kallysoft.ch/calendarView/delta?$deltatoken=abc`;

  function deltaRoutes(counter: { initial: number }): Route[] {
    return [
      (req) => {
        const r = rel(req.url);
        if (req.method === 'GET' && r.startsWith('/users/manuel@kallysoft.ch/calendarView/delta?startDateTime=')) {
          counter.initial++;
          return { body: { value: [{ id: 'E1', subject: 'x' }, { id: 'E2', '@removed': { reason: 'deleted' } }], '@odata.nextLink': `${GRAPH}/users/manuel@kallysoft.ch/calendarView/delta?$skiptoken=p2` } };
        }
        if (req.method === 'GET' && r.includes('$skiptoken=p2')) return { body: { value: [{ id: 'E3', subject: 'gone meanwhile' }], '@odata.deltaLink': DELTA_LINK } };
        if (req.method === 'GET' && r.includes('$deltatoken=expired')) return { status: 410, body: { error: { code: 'SyncStateNotFound' } } };
        if (req.method === 'GET' && r.includes('$deltatoken=abc')) return { body: { value: [], '@odata.deltaLink': DELTA_LINK } };
        if (req.method === 'POST' && r === '/$batch') {
          const { requests } = JSON.parse(req.body) as { requests: { id: string; url: string }[] };
          return {
            body: {
              responses: requests.map((q) =>
                q.url.includes('/events/E1?') ? { id: q.id, status: 200, body: graphEvent('E1') } : { id: q.id, status: 404, body: { error: { code: 'ErrorItemNotFound' } } },
              ),
            },
          };
        }
        return undefined;
      },
    ];
  }

  it('initial sync: window, paging to the deltaLink, removed items, re-read with extended properties via $batch', async () => {
    const counter = { initial: 0 };
    const { ff, rt } = graph(deltaRoutes(counter));
    const cal = new LiveCalendarAdapter(deps(config, handle.db, SYSTEM, NOW), rt);
    const res = await cal.delta('manuel@kallysoft.ch', null);
    const first = rel(ff.calls.find((c) => c.url.includes('startDateTime'))!.url);
    expect(first).toContain('startDateTime=2026-11-13T09:00:00.000Z');
    expect(first).toContain('endDateTime=2027-05-19T09:00:00.000Z');
    expect(ff.calls.find((c) => c.url.includes('startDateTime'))!.headers.prefer).toContain('odata.maxpagesize=50');
    expect(res.nextToken).toBe(`${DELTA_LINK}#sp-window=2026-11-20T09:00:00.000Z`);
    expect(res.changed.map((e) => e.id)).toEqual(['E1']);
    expect(res.changed[0].extendedProperties.KlsTerminId).toBe('T-2026-001');
    expect(res.deleted.sort()).toEqual(['E2', 'E3']);
  });

  it('expired delta state (410) → full resync; foreign delta links are never called', async () => {
    const counter = { initial: 0 };
    const { ff, rt } = graph(deltaRoutes(counter));
    const cal = new LiveCalendarAdapter(deps(config, handle.db, SYSTEM, NOW), rt);
    const res = await cal.delta('manuel@kallysoft.ch', `${GRAPH}/users/manuel@kallysoft.ch/calendarView/delta?$deltatoken=expired`);
    expect(counter.initial).toBe(1);
    expect(res.nextToken.startsWith(DELTA_LINK)).toBe(true);

    await cal.delta('manuel@kallysoft.ch', 'https://evil.example/steal?$deltatoken=abc');
    expect(counter.initial).toBe(2);
    expect(ff.calls.some((c) => c.url.includes('evil.example'))).toBe(false);
  });

  it('resumes with the deltaLink (window mark never sent) and moves the window after 7 days', async () => {
    const counter = { initial: 0 };
    const { ff, rt } = graph(deltaRoutes(counter));
    const cal = new LiveCalendarAdapter(deps(config, handle.db, SYSTEM, NOW), rt);
    const resumed = await cal.delta('manuel@kallysoft.ch', `${DELTA_LINK}#sp-window=2026-11-18T09:00:00.000Z`);
    expect(counter.initial).toBe(0);
    expect(resumed.nextToken).toBe(`${DELTA_LINK}#sp-window=2026-11-18T09:00:00.000Z`);
    expect(ff.calls.some((c) => c.url.includes('sp-window'))).toBe(false);

    const moved = await cal.delta('manuel@kallysoft.ch', `${DELTA_LINK}#sp-window=2026-11-01T00:00:00.000Z`);
    expect(counter.initial).toBe(1);
    expect(moved.nextToken.endsWith('#sp-window=2026-11-20T09:00:00.000Z')).toBe(true);
  });

  it('syncCalendarDelta stores the deltaLink in sync_state and reuses it; restarts after 7 days', async () => {
    const counter = { initial: 0 };
    const { rt } = graph(deltaRoutes(counter));
    const cal = new LiveCalendarAdapter(deps(config, handle.db, SYSTEM, NOW), rt);
    const r1 = await syncCalendarDelta(handle.db, cal, 'Manuel@kallysoft.ch', { now: NOW });
    expect(r1.reset).toBe(true);
    const stored = await loadDeltaToken(handle.db, 'manuel@kallysoft.ch');
    expect(stored?.token.startsWith(DELTA_LINK)).toBe(true);
    expect(stored?.polledAt).toBe(NOW.toISOString()); // same shape as the scheduling job ({ token, polledAt })
    const r2 = await syncCalendarDelta(handle.db, cal, 'manuel@kallysoft.ch', { now: new Date(NOW.getTime() + 60_000) });
    expect(r2.reset).toBe(false);
    expect(counter.initial).toBe(1);
    const r3 = await syncCalendarDelta(handle.db, cal, 'manuel@kallysoft.ch', { now: new Date(NOW.getTime() + 8 * 86_400_000) });
    expect(r3.reset).toBe(true);
    expect(counter.initial).toBe(2);
  });
});

describe('live mail – sendMail', () => {
  const draft = { to: ['kunde@muster.ch'], cc: ['chef@muster.ch'], subject: 'Use Cases', body: 'Grüezi <Frau Muster>\nFreundliche Grüsse' };
  const sendRoute: Route = (req) => (req.method === 'POST' && req.url.endsWith('/sendMail') ? { status: 202, text: '' } : undefined);

  it('delegated from the own mailbox; outside Prod redirected to MAIL_TEST_RECIPIENT, text HTML-escaped', async () => {
    const { ff, rt } = graph([sendRoute]);
    const mail = new LiveMailAdapter(deps(config, handle.db, MARKUS, NOW), rt);
    const sent = await mail.send({ userId: 'u-markus', email: 'markus@kallysoft.ch', displayName: 'Markus' }, draft);
    expect(sent).toMatchObject({ redirected: true, deliveredTo: ['test@kallysoft.ch'] });
    const req = ff.calls.find((c) => c.url.endsWith('/sendMail'))!;
    expect(req.url).toBe(`${GRAPH}/me/sendMail`);
    const { message, saveToSentItems } = JSON.parse(req.body);
    expect(saveToSentItems).toBe(true);
    expect(message.toRecipients).toEqual([{ emailAddress: { address: 'test@kallysoft.ch' } }]);
    expect(message.ccRecipients).toEqual([]);
    expect(message.body.contentType).toBe('HTML');
    expect(message.body.content).toContain('eigentlich an: kunde@muster.ch, chef@muster.ch');
    expect(message.body.content).toContain('Grüezi &lt;Frau Muster&gt;<br>Freundliche Grüsse');
  });

  it('never sends as somebody else (delegated) and refuses non-allowed sender mailboxes (app)', async () => {
    const { ff, rt } = graph([sendRoute]);
    const mail = new LiveMailAdapter(deps(config, handle.db, MARKUS, NOW), rt);
    await expect(mail.send({ userId: null, email: 'manuel@kallysoft.ch', displayName: 'Manuel' }, draft)).rejects.toMatchObject({ statusCode: 403 });
    const app = new LiveMailAdapter(deps(config, handle.db, SYSTEM, NOW), rt);
    await expect(app.send({ userId: null, email: 'ceo@kallysoft.ch', displayName: 'CEO' }, draft)).rejects.toBeInstanceOf(MailboxNotAllowedError);
    await app.send({ userId: null, email: 'nico@kallysoft.ch', displayName: 'Nico' }, draft);
    expect(ff.calls.filter((c) => c.url.endsWith('/sendMail')).map((c) => rel(c.url))).toEqual(['/users/nico@kallysoft.ch/sendMail']);
  });

  it('Prod sends to the real recipients; Sandbox without test recipient sends nothing', async () => {
    const prod = liveConfig({ ENVIRONMENT_LABEL: 'Prod', MAIL_TEST_RECIPIENT: '' });
    const g = graph([sendRoute], prod);
    const sent = await new LiveMailAdapter(deps(prod, handle.db, MARKUS, NOW), g.rt).send({ userId: 'u', email: 'markus@kallysoft.ch', displayName: 'M' }, draft);
    expect(sent).toMatchObject({ redirected: false, deliveredTo: ['kunde@muster.ch'] });
    expect(JSON.parse(g.ff.calls.at(-1)!.body).message.ccRecipients).toEqual([{ emailAddress: { address: 'chef@muster.ch' } }]);

    const sandbox = liveConfig({ ENVIRONMENT_LABEL: 'Sandbox', MAIL_TEST_RECIPIENT: '' });
    const s = graph([sendRoute], sandbox);
    await expect(new LiveMailAdapter(deps(sandbox, handle.db, MARKUS, NOW), s.rt).send({ userId: 'u', email: 'markus@kallysoft.ch', displayName: 'M' }, draft)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(s.ff.calls.filter((c) => c.url.endsWith('/sendMail'))).toHaveLength(0);
  });

  it('sendMail is retried on 429 only (never on 503 – the mail might already be out)', async () => {
    let n = 0;
    const g = graph([(req) => (req.url.endsWith('/sendMail') ? (++n === 1 ? { status: 429, headers: { 'Retry-After': '3' }, body: {} } : { status: 202, text: '' }) : undefined)]);
    await new LiveMailAdapter(deps(config, handle.db, MARKUS, NOW), g.rt).send({ userId: 'u', email: 'markus@kallysoft.ch', displayName: 'M' }, draft);
    expect(n).toBe(2);
    expect(g.sleeps).toEqual([3000]);

    const h = graph([(req) => (req.url.endsWith('/sendMail') ? { status: 503, body: {} } : undefined)]);
    await expect(new LiveMailAdapter(deps(config, handle.db, MARKUS, NOW), h.rt).send({ userId: 'u', email: 'markus@kallysoft.ch', displayName: 'M' }, draft)).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(h.ff.calls.filter((c) => c.url.endsWith('/sendMail'))).toHaveLength(1);
  });
});
