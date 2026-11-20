import { defineModule } from '../registry';
import { isWeeklyReportDue, lastSentWeek, sendWeeklyReport } from './report';
import { dashboardRoutes } from './routes';

export default defineModule({
  name: 'dashboard',
  routes: dashboardRoutes,
  jobs(registry) {
    // Weekly report: checked every 30 min, sent from Monday 07:00 (Zurich) once per week (INTENT 6.12, replaces the flow).
    registry.registerRecurring('dashboard.weekly_report', 30 * 60_000, async (ctx) => {
      const now = ctx.now();
      if (!isWeeklyReportDue(now, await lastSentWeek(ctx.db))) return;
      const result = await sendWeeklyReport(ctx.db, ctx.adapters, now);
      ctx.log.info({ result: result.status }, 'weekly report');
    });
  },
});
