/**
 * All portal modules (ARCHITECTURE §4). Prepared by the foundation – implementers edit only their own folder.
 * Routes are mounted at /api/<prefix ?? name>.
 */
import admin from './admin';
import ai from './ai';
import calls from './calls';
import changesets from './changesets';
import dashboard from './dashboard';
import history from './history';
import leads from './leads';
import me from './me';
import pendenzen from './pendenzen';
import type { PortalModule } from './registry';
import scheduling from './scheduling';
import workspace from './workspace';

export const MODULES: PortalModule[] = [me, leads, workspace, calls, changesets, pendenzen, history, scheduling, ai, dashboard, admin];
