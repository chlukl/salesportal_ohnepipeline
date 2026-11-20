/** Labels and icons for Pendenzen (everyday language, INTENT 6.0). */
import type { PendenzDue, PendenzEntry, PendenzKind, PendenzOrigin } from '@sales-portal/shared';
import {
  CalendarDays,
  CalendarX2,
  ClipboardCheck,
  FileText,
  ListTodo,
  Mail,
  PhoneCall,
  PhoneOutgoing,
  Search,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { primaryAction } from './actions';

export const KIND_ORDER: PendenzKind[] = [
  'unfinished_call',
  'task',
  'booking',
  'briefing',
  'cancellation',
  'analysis',
  'approval',
  'error',
  'campaign_reply',
];

export const KIND_LABELS: Record<PendenzKind, string> = {
  unfinished_call: 'Offene Anrufe',
  task: 'Aufgaben',
  booking: 'Termine',
  briefing: 'Briefings',
  cancellation: 'Absagen',
  analysis: 'Analysen',
  approval: 'Freigaben',
  error: 'Fehler',
  campaign_reply: 'Kampagne',
};

export const DUE_LABELS: Record<PendenzDue, string> = {
  overdue: 'überfällig',
  today: 'heute',
  this_week: 'diese Woche',
  later: 'später',
  none: 'ohne Datum',
};

export const ORIGIN_LABELS: Record<PendenzOrigin, string> = {
  coldcall: 'Coldcall',
  campaign: 'Kampagne',
  other: 'andere',
};

const KIND_ICONS: Record<PendenzKind, LucideIcon> = {
  unfinished_call: PhoneCall,
  task: ListTodo,
  booking: CalendarDays,
  briefing: FileText,
  cancellation: CalendarX2,
  analysis: Sparkles,
  approval: ClipboardCheck,
  error: TriangleAlert,
  campaign_reply: Mail,
};

export function iconFor(item: Pick<PendenzEntry, 'kind' | 'taskType'>): LucideIcon {
  if (item.kind === 'task' && item.taskType === 'callback') return PhoneOutgoing;
  if (item.kind === 'task' && item.taskType === 'research') return Search;
  return KIND_ICONS[item.kind];
}

/** Label of the main button in the page header for the top item (rules in `./actions`). */
export function primaryLabel(item: PendenzEntry): string {
  return primaryAction(item).label;
}
