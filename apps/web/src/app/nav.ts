/**
 * Left navigation (ARCHITECTURE §8). Visible only when an effective role allows it – the server enforces anyway.
 * Shared file: add entries only additively.
 */
import type { Role } from '@sales-portal/shared';
import { BarChart3, History, Lightbulb, ListChecks, PhoneOutgoing, Settings2, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  /** Short label under the icon in the slim navigation. */
  shortLabel: string;
  icon: LucideIcon;
  roles: Role[];
  /** Two-key shortcut ('g p'). */
  shortcut: string;
  end?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Pendenzen', shortLabel: 'Pendenzen', icon: ListChecks, roles: ['coldcaller', 'sales', 'ai_specialist', 'admin'], shortcut: 'g p', end: true },
  { to: '/anrufliste', label: 'Anrufliste', shortLabel: 'Anrufliste', icon: PhoneOutgoing, roles: ['coldcaller', 'admin'], shortcut: 'g a' },
  { to: '/historie', label: 'Anrufhistorie', shortLabel: 'Historie', icon: History, roles: ['coldcaller', 'admin'], shortcut: 'g h' },
  { to: '/dashboard', label: 'Dashboard', shortLabel: 'Zahlen', icon: BarChart3, roles: ['sales', 'ai_specialist', 'admin'], shortcut: 'g d' },
  { to: '/use-cases', label: 'Use Cases', shortLabel: 'Use Cases', icon: Lightbulb, roles: ['sales', 'ai_specialist', 'admin'], shortcut: 'g u' },
  { to: '/admin', label: 'Admin', shortLabel: 'Admin', icon: Settings2, roles: ['admin'], shortcut: 'g x' },
];
