/**
 * /api/scheduling – Slots, Buchen, 3 Vorschläge, Blocker, Buchungen (INTENT 6.6, 6.8, 6.11).
 * Every route declares its roles; object-level checks in service.ts (`canSeeBooking`, `canChangeBooking`).
 */
import { CANCELLATION_CALL_STATUSES, atLocalTime, type BookingRules } from '@sales-portal/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ROLESETS, requireRoles } from '../../auth/rbac';
import { MockCalendarAdapter } from '../../integrations/calendar/mock';
import { audit } from '../../lib/audit';
import { badRequest, forbidden } from '../../lib/errors';
import { crmId, isoDateTime, queryBool, uuidParam } from '../../lib/zod';
import { pollCalendarChanges } from './delta';
import { computeProposals, monthsInfo, sendProposals, swapOne } from './proposals';
import {
  bookingContext,
  bookingMailboxes,
  callStatusAfterCancellation,
  cancelBookingByUser,
  createBooking,
  getBookingFor,
  getBookingRules,
  listBookings,
  moveBookingByUser,
  searchSlots,
  toBooking,
} from './service';
import { depsFromRequest } from './util';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const isoMonth = z.string().regex(/^\d{4}-\d{2}-01$/, 'Monat im Format JJJJ-MM-01');
const email = z.string().trim().min(3).max(254);
const preference = z.enum(['any', 'morning', 'afternoon']);
const text = (max: number) => z.string().max(max);

const bookingBody = z.object({
  leadId: crmId,
  callSessionId: z.string().uuid().nullish(),
  start: isoDateTime,
  extraCall: z.boolean().default(false),
  subject: z.string().trim().min(1).max(255),
  body: text(20_000).default(''),
  attendees: z
    .array(z.object({ email, name: z.string().trim().max(200).nullish(), isMainContact: z.boolean().optional() }))
    .min(1)
    .max(10),
  needsPreparation: z.boolean().default(false),
  preparationNote: z.string().trim().max(2000).nullish(),
  decisionMakerInMeeting: z.boolean().optional(),
  budgetMentioned: z.boolean().optional(),
});

const proposalQuery = z.object({
  leadId: crmId,
  month: isoMonth,
  preference: preference.default('any'),
  extraCall: z.boolean().default(false),
  excludeStarts: z.array(isoDateTime).max(200).optional(),
});

export const schedulingRoutes: FastifyPluginAsyncZod = async (app) => {
  const coldcall = requireRoles(...ROLESETS.coldcall);

  app.get('/rules', { config: coldcall }, async (): Promise<BookingRules> => getBookingRules(app.db));

  /** Everything the panel needs for one lead: participants, subject + invitation template, existing bookings. */
  app.get(
    '/context/:leadId',
    { config: coldcall, schema: { params: z.object({ leadId: crmId }) } },
    async (request) => bookingContext(depsFromRequest(request), request.auth!, request.params.leadId),
  );

  /** Free starts for the week view (all participants free incl. buffers; Zusatzcall only where Manuel cannot). */
  app.get(
    '/slots',
    {
      config: coldcall,
      schema: {
        querystring: z.object({
          from: isoDate,
          days: z.coerce.number().int().min(1).max(31).default(7),
          extraCall: queryBool,
        }),
      },
    },
    async (request) => {
      const { from, days, extraCall } = request.query;
      const start = atLocalTime(from, '00:00');
      const [y, m, d] = from.split('-').map(Number);
      const endIso = new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
      const result = await searchSlots(depsFromRequest(request), { from: start, to: atLocalTime(endIso, '00:00'), extraCall: !!extraCall });
      return { from, to: endIso, ...result };
    },
  );

  // ---- bookings ------------------------------------------------------------------------------------------------------

  app.post('/bookings', { config: coldcall, schema: { body: bookingBody } }, async (request, reply) => {
    const result = await createBooking(depsFromRequest(request), request.auth!, request.body);
    reply.status(201);
    return result;
  });

  app.get(
    '/bookings',
    {
      config: requireRoles(...ROLESETS.workspace),
      schema: {
        querystring: z.object({
          leadId: crmId.optional(),
          status: z.enum(['booked', 'rescheduled', 'cancelled', 'held']).optional(),
          upcoming: queryBool,
        }),
      },
    },
    async (request) => {
      const { leadId, status, upcoming } = request.query;
      // Lead context (all bookings of a lead) only for roles that work on leads.
      if (leadId && !request.auth!.effectiveRoles.some((r) => r === 'coldcaller' || r === 'admin')) {
        const own = await listBookings(app.db, request.auth!, { status: status ? [status] : undefined, upcoming: !!upcoming }, app.ctx.now());
        return { items: own.filter((b) => b.leadId === leadId) };
      }
      return { items: await listBookings(app.db, request.auth!, { leadId, status: status ? [status] : undefined, upcoming: !!upcoming }, app.ctx.now()) };
    },
  );

  app.get('/bookings/:id', { config: requireRoles(...ROLESETS.workspace), schema: { params: uuidParam } }, async (request) =>
    toBooking(await getBookingFor(app.db, request.auth!, request.params.id)),
  );

  app.post('/bookings/:id/cancel', { config: coldcall, schema: { params: uuidParam } }, async (request) =>
    cancelBookingByUser(depsFromRequest(request), request.auth!, request.params.id),
  );

  app.post(
    '/bookings/:id/move',
    { config: coldcall, schema: { params: uuidParam, body: z.object({ start: isoDateTime }) } },
    async (request) => moveBookingByUser(depsFromRequest(request), request.auth!, request.params.id, request.body.start),
  );

  /** After a cancellation: Markus picks the new call status → change set for the approval preview. */
  app.post(
    '/bookings/:id/callstatus',
    {
      config: coldcall,
      schema: {
        params: uuidParam,
        body: z.object({ callStatus: z.number().int().refine((v) => CANCELLATION_CALL_STATUSES.includes(v), 'Anrufstatus nicht erlaubt') }),
      },
    },
    async (request) => callStatusAfterCancellation(depsFromRequest(request), request.auth!, request.params.id, request.body.callStatus),
  );

  /**
   * Demo only (mock calendar, admin): simulate what customers and colleagues do in Outlook, then run the watcher once.
   * Lets Lukas show cancellations, declines and moves without real mailboxes.
   */
  app.post(
    '/bookings/:id/simulate',
    {
      config: requireRoles('admin'),
      schema: {
        params: uuidParam,
        body: z.object({
          action: z.enum(['cancel', 'decline_main', 'decline_other', 'decline_specialist', 'move']),
          start: isoDateTime.optional(),
        }),
      },
    },
    async (request) => {
      const deps = depsFromRequest(request);
      const calendar = deps.systemCalendar;
      if (!(calendar instanceof MockCalendarAdapter)) throw forbidden('Nur im Demo-Kalender möglich');
      const row = await getBookingFor(app.db, request.auth!, request.params.id);
      if (!row.eventId) throw badRequest('Termin hat keinen Kalendereintrag');
      const rules = await getBookingRules(app.db);
      const { sales, specialist } = await bookingMailboxes(app.db, rules, row);
      const { action, start } = request.body;
      if (action === 'cancel') await calendar.simulateCancel(sales, row.eventId);
      if (action === 'decline_specialist') await calendar.simulateResponse(sales, row.eventId, specialist, 'declined');
      if (action === 'decline_main' || action === 'decline_other') {
        const target = row.externalAttendees.find((a) => a.isMainContact === (action === 'decline_main'));
        if (!target) throw badRequest(action === 'decline_main' ? 'Keine Hauptperson eingeladen' : 'Keine weitere Person eingeladen');
        await calendar.simulateResponse(sales, row.eventId, target.email, 'declined');
      }
      if (action === 'move') {
        const next = start ?? new Date(row.startAt.getTime() + 24 * 3_600_000).toISOString();
        await calendar.simulateMove(sales, row.eventId, next);
      }
      await audit(app.db, { actor: request.auth!.actor, action: 'scheduling.demo_simulate', entity: 'booking', entityId: row.id, meta: { action } });
      const stats = await pollCalendarChanges(deps);
      return { stats, booking: toBooking(await getBookingFor(app.db, request.auth!, row.id)) };
    },
  );

  // ---- 3 Vorschläge --------------------------------------------------------------------------------------------------

  app.get('/proposals/months', { config: coldcall }, async () => monthsInfo(app.ctx.now()));

  app.post('/proposals', { config: coldcall, schema: { body: proposalQuery } }, async (request) =>
    computeProposals(depsFromRequest(request), request.auth!, request.body),
  );

  app.post(
    '/proposals/swap',
    {
      config: coldcall,
      schema: {
        body: proposalQuery.extend({
          current: z.array(z.object({ start: isoDateTime, end: isoDateTime })).min(1).max(3),
          index: z.number().int().min(0).max(2),
        }),
      },
    },
    async (request) => swapOne(depsFromRequest(request), request.auth!, request.body),
  );

  app.post(
    '/proposals/send',
    {
      config: coldcall,
      schema: {
        body: z.object({
          leadId: crmId,
          callSessionId: z.string().uuid().nullish(),
          to: z.array(email).min(1).max(5),
          cc: z.array(email).max(5).optional(),
          subject: z.string().trim().min(1).max(255),
          body: z.string().trim().min(1).max(20_000),
        }),
      },
    },
    async (request) => sendProposals(depsFromRequest(request), request.auth!, request.body),
  );
};
