/** Core maintenance jobs (not owned by a module): expired sessions, finished jobs, transcript retention. */
import { and, inArray, lt } from 'drizzle-orm';
import { purgeExpiredSessions } from '../auth/session';
import { jobs, transcripts } from '../db/schema';
import { audit } from '../lib/audit';
import type { JobRegistry } from './registry';

export function registerCoreJobs(registry: JobRegistry): void {
  registry.registerRecurring('core.sessions_cleanup', 60 * 60_000, async (ctx) => {
    await purgeExpiredSessions(ctx.db, ctx.config);
  });

  registry.registerRecurring('core.jobs_cleanup', 24 * 60 * 60_000, async (ctx) => {
    const before = new Date(ctx.now().getTime() - 14 * 86_400_000);
    await ctx.db.delete(jobs).where(and(inArray(jobs.status, ['done', 'dead']), lt(jobs.updatedAt, before)));
  });

  // ARCHITECTURE §5.10: transcripts only in the portal DB, deleted after the retention period (delete_after).
  registry.registerRecurring('core.transcripts_retention', 60 * 60_000, async (ctx) => {
    const deleted = await ctx.db.delete(transcripts).where(lt(transcripts.deleteAfter, ctx.now())).returning({ id: transcripts.id });
    if (deleted.length) {
      await audit(ctx.db, { actor: 'system', action: 'transcripts.retention_delete', entity: 'transcript', meta: { count: deleted.length } });
      ctx.log.info({ count: deleted.length }, 'transcripts deleted (retention)');
    }
  });
}
