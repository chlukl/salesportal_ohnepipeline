import { defineModule } from '../registry';
import { leadsRoutes } from './routes';

export default defineModule({
  name: 'leads',
  routes: leadsRoutes,
});
