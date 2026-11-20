import { defineModule } from '../registry';
import { adminRoutes } from './routes';
import { notifySecretExpiry } from './service';

export default defineModule({
  name: 'admin',
  routes: adminRoutes,
  jobs(registry) {
    // INTENT 12 «Abgelaufene Geheimnisse»: warn admins 30 days before the entered expiry date (once per secret/status).
    registry.registerRecurring('admin.secret_expiry_check', 6 * 60 * 60_000, async (ctx) => {
      const n = await notifySecretExpiry(ctx.db, ctx.config, ctx.now());
      if (n) ctx.log.info({ count: n }, 'secret expiry notifications');
    });
  },
});
