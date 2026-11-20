/** Job handlers of the ai module (registered via defineModule). All handlers are idempotent. */
import { z } from 'zod';
import type { JobRegistry } from '../../jobs/registry';
import { analyzeCallJob } from './analysis';
import { briefingMailJob, buildBriefingJob, deliverBriefingJob, JOB_BRIEFING_MAIL, JOB_BUILD_BRIEFING, JOB_DELIVER_BRIEFING, sweepBookingsWithoutBriefing } from './briefing';
import { aiDepsFromJob } from './service';
import { fetchTranscriptJob, JOB_ANALYZE_CALL, JOB_FETCH_TRANSCRIPT, JOB_SYNC_DURATION, sweepEndedCalls, syncCallDurationJob } from './transcripts';
import { cleanupDeliveries } from './veraWebhook';

const analysisPayload = z.object({ analysisId: z.string().uuid() });
const bookingPayload = z.object({ bookingId: z.string().uuid() });
const durationPayload = z.object({ callSessionId: z.string().uuid(), transcriptId: z.string().uuid() });

export function registerAiJobs(registry: JobRegistry): void {
  registry.register(JOB_FETCH_TRANSCRIPT, async (payload, ctx) => {
    await fetchTranscriptJob(aiDepsFromJob(ctx), analysisPayload.parse(payload).analysisId);
  });
  registry.register(
    JOB_ANALYZE_CALL,
    async (payload, ctx) => {
      await analyzeCallJob(aiDepsFromJob(ctx), analysisPayload.parse(payload).analysisId, ctx.job.attempts >= ctx.job.maxAttempts);
    },
    { maxAttempts: 3 },
  );
  registry.register(JOB_SYNC_DURATION, async (payload, ctx) => {
    const p = durationPayload.parse(payload);
    await syncCallDurationJob(aiDepsFromJob(ctx), p.callSessionId, p.transcriptId);
  });
  registry.register(
    JOB_BUILD_BRIEFING,
    async (payload, ctx) => {
      await buildBriefingJob(aiDepsFromJob(ctx), bookingPayload.parse(payload).bookingId);
    },
    { maxAttempts: 3 },
  );
  registry.register(JOB_DELIVER_BRIEFING, async (payload, ctx) => {
    await deliverBriefingJob(aiDepsFromJob(ctx), bookingPayload.parse(payload).bookingId);
  });
  registry.register(JOB_BRIEFING_MAIL, async (payload, ctx) => {
    await briefingMailJob(aiDepsFromJob(ctx), bookingPayload.parse(payload).bookingId);
  });

  registry.registerRecurring('ai.transcript_sweep', 60_000, async (ctx) => {
    await sweepEndedCalls(aiDepsFromJob(ctx));
  });
  registry.registerRecurring('ai.briefing_sweep', 5 * 60_000, async (ctx) => {
    await sweepBookingsWithoutBriefing(aiDepsFromJob(ctx));
  });
  registry.registerRecurring('ai.webhook_delivery_cleanup', 60 * 60_000, async (ctx) => {
    await cleanupDeliveries(aiDepsFromJob(ctx));
  });
}
