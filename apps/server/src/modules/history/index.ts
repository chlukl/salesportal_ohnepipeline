import { defineModule } from '../registry';
import { historyRoutes } from './routes';
import { countOpenMissed } from './service';

export default defineModule({
  name: 'history',
  routes: historyRoutes,
  counters: {
    // Only coldcallers (and admins) take callbacks; other roles see 0 without a query.
    missedCallbacks: async (ctx) =>
      ctx.auth.effectiveRoles.some((r) => r === 'coldcaller' || r === 'admin') ? countOpenMissed(ctx.db, ctx.adapters, ctx.auth, new Date()) : 0,
  },
});
