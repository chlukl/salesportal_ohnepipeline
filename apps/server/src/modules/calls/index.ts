import { defineModule } from '../registry';
import { callsRoutes } from './routes';
import { sweepStaleCalls } from './service';

export default defineModule({
  name: 'calls',
  routes: callsRoutes,
  jobs(registry) {
    // Forgotten calls (> 2 h dialing / connected) move to the wrap-up list – never discarded.
    registry.registerRecurring('calls.sweep_stale', 15 * 60_000, async (ctx) => {
      const n = await sweepStaleCalls(ctx.db, ctx.now());
      if (n) ctx.log.info({ count: n }, 'stale calls moved to wrap-up');
    });
  },
});
