import { defineModule } from '../registry';
import { workspaceRoutes } from './routes';

export default defineModule({
  name: 'workspace',
  routes: workspaceRoutes,
});
