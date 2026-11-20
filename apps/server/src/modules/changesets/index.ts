import { defineModule } from '../registry';
import { changesetsRoutes } from './routes';

export default defineModule({
  name: 'changesets',
  routes: changesetsRoutes,
});
