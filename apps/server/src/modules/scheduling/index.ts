import { defineModule } from '../registry';
import { SYNC_BOOKING_JOB, syncCrmBookingJob } from './crmSync';
import { ensureBlockersJob, pollCalendarChanges } from './delta';
import { schedulingRoutes } from './routes';
import { depsFromJob } from './util';

/** Delta polling interval (INTENT 6.11: «alle paar Minuten»). */
export const CALENDAR_DELTA_EVERY_MS = 3 * 60_000;

export default defineModule({
  name: 'scheduling',
  routes: schedulingRoutes,
  jobs(registry) {
    // Absagen / Verschiebungen erkennen – background task, no approval needed (INTENT 5).
    registry.registerRecurring('scheduling.calendar_delta', CALENDAR_DELTA_EVERY_MS, async (ctx) => {
      const stats = await pollCalendarChanges(depsFromJob(ctx));
      if (stats.changed || stats.errors) ctx.log.info({ stats }, 'calendar delta processed');
    });
    // Blockers that could not be set while booking.
    registry.register<{ bookingId: string }>(
      'scheduling.ensure_blockers',
      async (payload, ctx) => {
        if (typeof payload.bookingId !== 'string') return;
        await ensureBlockersJob(depsFromJob(ctx), payload.bookingId);
      },
      { maxAttempts: 8 },
    );
    // kls_buchung writes that failed while booking / moving / cancelling (live CRM only).
    registry.register<{ bookingId: string }>(
      SYNC_BOOKING_JOB,
      async (payload, ctx) => {
        if (typeof payload.bookingId !== 'string') return;
        await syncCrmBookingJob(depsFromJob(ctx), payload.bookingId);
      },
      { maxAttempts: 8 },
    );
  },
});
