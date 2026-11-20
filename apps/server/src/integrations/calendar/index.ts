import type { AdapterDeps } from '../types';
import { LiveCalendarAdapter } from './live';
import { MockCalendarAdapter } from './mock';
import type { CalendarAdapter } from './types';

export type { CalendarAdapter } from './types';

export function createCalendarAdapter(deps: AdapterDeps): CalendarAdapter {
  return deps.config.adapters.calendar === 'live' ? new LiveCalendarAdapter(deps) : new MockCalendarAdapter(deps);
}
