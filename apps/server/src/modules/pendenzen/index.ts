import { defineModule } from '../registry';
import { pendenzenRoutes } from './routes';
import { countOpenPendenzen } from './service';

export default defineModule({
  name: 'pendenzen',
  routes: pendenzenRoutes,
  counters: {
    pendenzen: async (ctx) => countOpenPendenzen(ctx.db, ctx.adapters, ctx.auth, new Date()),
  },
});
