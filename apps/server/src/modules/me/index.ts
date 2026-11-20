import { defineModule } from '../registry';
import { meRoutes } from './routes';

export default defineModule({
  name: 'me',
  routes: meRoutes,
});
