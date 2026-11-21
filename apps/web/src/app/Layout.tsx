/** App shell: fixed header, slim left navigation (filtered by effective roles), content outlet, global overlays. */
import { ROLE_LABELS } from '@sales-portal/shared';
import { useQuery } from '@tanstack/react-query';
import { Eye } from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { Button, cn, Tooltip } from '@/components/ui';
import { callApi, useRestoreActiveCall } from '@/pages/calls';
import { errorMessage } from './api';
import { useAuth } from './auth';
import { Header } from './Header';
import { NAV_ITEMS, type NavItem } from './nav';
import { shortcutOverlay, ShortcutOverlay, useShortcut } from './shortcuts';
import { toast } from './toast';

function NavShortcut({ item }: { item: NavItem }) {
  const navigate = useNavigate();
  useShortcut(item.shortcut, () => navigate(item.to), { description: item.label, group: 'Navigation' });
  return null;
}

function SideNav() {
  const { hasRole } = useAuth();
  const items = NAV_ITEMS.filter((item) => hasRole(...item.roles));
  return (
    <nav
      aria-label="Hauptnavigation"
      className="fixed top-[var(--kls-header-h)] bottom-0 left-0 z-20 flex w-[var(--kls-nav-w)] flex-col items-center gap-1 border-r border-border bg-surface py-3"
    >
      {items.map((item) => (
        <NavShortcut key={item.to} item={item} />
      ))}
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Tooltip key={item.to} content={item.label} side="right">
            <NavLink
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'flex w-[72px] flex-col items-center gap-1 rounded-lg px-1 py-2 text-[11px] font-medium transition-colors',
                  isActive ? 'bg-primary-subtle text-primary' : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
                )
              }
            >
              <Icon className="size-5" aria-hidden />
              <span className="w-full truncate text-center">{item.shortLabel}</span>
            </NavLink>
          </Tooltip>
        );
      })}
    </nav>
  );
}

function ViewAsBanner() {
  const { me, setViewAs } = useAuth();
  if (!me.viewAs) return null;
  return (
    <div className="mb-5 flex items-center justify-between gap-4 rounded-lg border border-info/30 bg-info-subtle px-4 py-2.5 text-sm text-info">
      <span className="flex items-center gap-2">
        <Eye className="size-4" aria-hidden />
        Ansicht als <strong className="font-semibold">{ROLE_LABELS[me.viewAs]}</strong> – du siehst das Portal so wie diese Rolle.
      </span>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => setViewAs(null).catch((err) => toast.error(errorMessage(err)))}
      >
        Zurück zu meinen Rollen
      </Button>
    </div>
  );
}

/**
 * The header's call status reflects the server on every page (also Pendenzen, Historie, Dashboard, Admin): after a
 * reload, in a new tab or after a new login a call «im Gespräch» / in «Nachbearbeitung» is shown again. Refetched every
 * minute so the server's stale sweep (> 2 h → Nachbearbeitung) and calls finished in another tab show up.
 */
function ActiveCallSync() {
  const { hasRole } = useAuth();
  useRestoreActiveCall();
  useQuery({
    queryKey: ['calls', 'active'],
    queryFn: callApi.active,
    refetchInterval: 60_000,
    staleTime: 15_000,
    enabled: hasRole('coldcaller', 'admin'),
  });
  return null;
}

export function Layout() {
  useShortcut('?', () => shortcutOverlay.set((o) => !o), { description: 'Tastaturkürzel anzeigen', group: 'Allgemein', global: true });
  return (
    <div className="min-h-full">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2">
        Zum Inhalt springen
      </a>
      <ActiveCallSync />
      <Header />
      <SideNav />
      <main id="main" tabIndex={-1} className="pt-[var(--kls-header-h)] pl-[var(--kls-nav-w)] outline-none">
        <div className="mx-auto max-w-[1680px] px-8 py-7">
          <ViewAsBanner />
          <Outlet />
        </div>
      </main>
      <ShortcutOverlay />
    </div>
  );
}
