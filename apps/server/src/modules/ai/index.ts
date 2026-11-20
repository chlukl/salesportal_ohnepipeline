import { defineModule } from '../registry';
import { countReadyAnalyses } from './analysis';
import { registerAiJobs } from './jobs';
import { aiRoutes } from './routes';

export default defineModule({
  name: 'ai',
  routes: aiRoutes,
  counters: {
    // «Analysen zur Freigabe» in the header: own call analyses waiting for review (coldcaller / admin view only).
    analysen: async (ctx) =>
      ctx.auth.effectiveRoles.some((r) => r === 'coldcaller' || r === 'admin') ? countReadyAnalyses(ctx, ctx.auth.user.id) : 0,
  },
  jobs: registerAiJobs,
});
