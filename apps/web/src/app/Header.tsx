/**
 * Fixed header (ARCHITECTURE §8): call status · counters · callback search («/») · environment · user + «Ansicht als».
 */
import { CALL_PHASE_LABELS, ROLE_LABELS, ROLES, type HeaderCounters, type Role } from '@sales-portal/shared';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Eye, Keyboard, ListChecks, LogOut, Monitor, Moon, PhoneMissed, Sparkles, Sun, Undo2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { Badge, BrandMark, cn, DropdownMenu, Kbd, Tooltip, type MenuSection } from '@/components/ui';
import { api, errorMessage } from './api';
import { useAuth } from './auth';
import { useCallState, useElapsed } from './callState';
import { CallbackSearchField } from '@/pages/history/CallbackSearch';
import { shortcutOverlay } from './shortcuts';
import { DESIGNS, setDesign, setTheme, useDesign, useTheme } from './theme';
import { toast } from './toast';

function CallStatus() {
  const call = useCallState();
  const elapsed = useElapsed(call.phase === 'connected' ? call.connectedAt : call.phase === 'dialing' ? call.dialedAt : null);
  const navigate = useNavigate();
  const styles = {
    idle: { dot: 'bg-fg-subtle', text: 'text-fg-muted', ring: 'border-border' },
    dialing: { dot: 'bg-call-dialing pulse-dot', text: 'text-call-dialing', ring: 'border-call-dialing/40' },
    connected: { dot: 'bg-call-connected pulse-dot', text: 'text-call-connected', ring: 'border-call-connected/40' },
    wrapup: { dot: 'bg-call-wrapup', text: 'text-call-wrapup', ring: 'border-call-wrapup/40' },
  }[call.phase];
  const label =
    call.phase === 'connected'
      ? `${CALL_PHASE_LABELS.connected} ${elapsed}`
      : call.phase === 'dialing'
        ? `${CALL_PHASE_LABELS.dialing} …`
        : CALL_PHASE_LABELS[call.phase];
  const who = [call.personName, call.companyName].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      onClick={() => call.leadId && navigate(`/lead/${call.leadId}`)}
      disabled={!call.leadId}
      aria-live="polite"
      className={cn('flex h-8 items-center gap-2 rounded-full border bg-surface px-3 text-[13px] font-medium disabled:cursor-default', styles.ring)}
    >
      <span className={cn('size-2 rounded-full', styles.dot)} aria-hidden />
      <span className={cn('tabular', styles.text)}>{label}</span>
      {who && call.phase !== 'idle' && (
        // Name/company only from 1440 px – at 1280 px the header must not overflow during a call.
        <span className="hidden max-w-[220px] truncate font-normal text-fg-muted min-[1440px]:inline">{who}</span>
      )}
    </button>
  );
}

function Counter({ to, icon: Icon, value, label }: { to: string; icon: typeof ListChecks; value: number; label: string }) {
  return (
    <Tooltip content={label}>
      <Link
        to={to}
        aria-label={`${label}: ${value}`}
        className={cn(
          'tabular flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium transition-colors hover:bg-surface-2',
          value > 0 ? 'text-fg' : 'text-fg-subtle',
        )}
      >
        <Icon className="size-4" aria-hidden />
        {value}
      </Link>
    </Tooltip>
  );
}

function Counters() {
  const { hasRole } = useAuth();
  // Analyses and missed callbacks belong to calling – Sales / AI-Spezialist never call (and may not open /historie).
  const calls = hasRole('coldcaller', 'admin');
  const { data } = useQuery({
    queryKey: ['me', 'counters'],
    queryFn: () => api.get<HeaderCounters>('/api/me/counters'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const c = data ?? { pendenzen: 0, analysen: 0, missedCallbacks: 0 };
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Counter to="/" icon={ListChecks} value={c.pendenzen} label="Offene Pendenzen" />
      {calls && <Counter to="/?art=analysis" icon={Sparkles} value={c.analysen} label="Analysen zur Freigabe" />}
      {calls && <Counter to="/historie?kategorie=callback_missed" icon={PhoneMissed} value={c.missedCallbacks} label="Verpasste Rückrufe" />}
    </div>
  );
}

/** Rückruf-Suche («/», INTENT 6.18) – implemented by the history module in `@/pages/history/CallbackSearch`. */
function CallbackSearch() {
  return <CallbackSearchField />;
}

function EnvironmentBadge() {
  const { me } = useAuth();
  const label = me.environment.label;
  const tone = label === 'Prod' ? 'danger' : label === 'Sandbox' ? 'warning' : 'info';
  return (
    <Tooltip content={`Umgebung: ${label}${me.environment.integrations !== 'live' ? ' · Demo-Daten' : ''}`}>
      <Badge tone={tone} variant="outline" dot size="md">
        {label}
      </Badge>
    </Tooltip>
  );
}

function UserMenu() {
  const { me, setViewAs, logout } = useAuth();
  const theme = useTheme();
  const design = useDesign();
  const initials = me.user.displayName
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const changeView = async (role: Role | null) => {
    try {
      await setViewAs(role);
      toast.info(role ? `Ansicht als ${ROLE_LABELS[role]}` : 'Zurück zu deinen Rollen');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const roleSummary = me.viewAs
    ? `Ansicht als ${ROLE_LABELS[me.viewAs]}`
    : me.roles.length > 2
      ? `${me.roles.length} Rollen`
      : me.roles.map((r) => ROLE_LABELS[r]).join(' · ') || 'Keine Rolle';

  const sections: MenuSection[] = [];
  if (me.isRealAdmin) {
    sections.push({
      key: 'view-as',
      title: 'Ansicht als',
      items: [
        ...ROLES.map((role) => ({ key: role, label: ROLE_LABELS[role], icon: Eye, checked: me.viewAs === role, onSelect: () => void changeView(role) })),
        ...(me.viewAs ? [{ key: 'back', label: 'Zurück zu meinen Rollen', icon: Undo2, onSelect: () => void changeView(null) }] : []),
      ],
    });
  }
  sections.push({
    key: 'design',
    title: 'Design',
    items: DESIGNS.map((d) => ({
      key: `design-${d.id}`,
      label: (
        <span className="flex items-center gap-2.5">
          <span className={cn('size-3.5 shrink-0 rounded-full ring-2', d.swatch)} aria-hidden />
          <span className="leading-tight">
            <span className="block">{d.label}</span>
            <span className="block text-[11px] text-fg-subtle">{d.description}</span>
          </span>
        </span>
      ),
      checked: design === d.id,
      onSelect: () => setDesign(d.id),
    })),
  });
  sections.push({
    key: 'theme',
    title: 'Hell / Dunkel',
    items: [
      { key: 'light', label: 'Hell', icon: Sun, checked: theme === 'light', onSelect: () => setTheme('light') },
      { key: 'dark', label: 'Dunkel', icon: Moon, checked: theme === 'dark', onSelect: () => setTheme('dark') },
      { key: 'system', label: 'Wie System', icon: Monitor, checked: theme === 'system', onSelect: () => setTheme('system') },
    ],
  });
  sections.push({
    key: 'misc',
    items: [
      { key: 'kbd', label: 'Tastaturkürzel', icon: Keyboard, hint: <Kbd>?</Kbd>, onSelect: () => shortcutOverlay.set(true) },
      { key: 'logout', label: 'Abmelden', icon: LogOut, danger: true, onSelect: () => void logout() },
    ],
  });

  return (
    <DropdownMenu
      sections={sections}
      header={
        <div className="mb-1.5 border-b border-border px-2 pt-1 pb-2.5">
          <p className="text-sm font-medium text-fg">{me.user.displayName}</p>
          <p className="text-xs text-fg-muted">{me.user.email}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {me.roles.map((r) => (
              <Badge key={r} tone={me.effectiveRoles.includes(r) ? 'primary' : 'neutral'}>
                {me.effectiveRoles.includes(r) && <Check className="size-3" aria-hidden />}
                {ROLE_LABELS[r]}
              </Badge>
            ))}
            {me.roles.length === 0 && <Badge tone="warning">Keine Rolle</Badge>}
          </div>
        </div>
      }
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          title={`${me.user.displayName} · ${roleSummary}`}
          className="flex h-9 min-w-0 items-center gap-2 rounded-md pr-1.5 pl-1 hover:bg-surface-2"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-fg">{initials}</span>
          <span className="min-w-0 text-left leading-tight">
            <span className="block max-w-[160px] truncate text-[13px] font-medium text-fg">{me.user.displayName}</span>
            {/* Role line only from 1440 px; several roles are summarised («4 Rollen»), the menu lists them all. */}
            <span className="hidden max-w-[200px] truncate text-[11px] text-fg-subtle min-[1440px]:block">{roleSummary}</span>
          </span>
          <ChevronDown className="size-3.5 text-fg-subtle" aria-hidden />
        </button>
      )}
    />
  );
}

export function Header() {
  const { hasRole } = useAuth();
  // Call status only for people who call (Sales / AI-Spezialist never do – «Bereit» would mean nothing to them).
  const calls = hasRole('coldcaller', 'admin');
  return (
    <header className="fixed inset-x-0 top-0 z-30 flex h-[var(--kls-header-h)] items-center gap-4 border-b border-border bg-surface/95 pr-4 pl-4 backdrop-blur">
      <Link to="/" className="flex w-[calc(var(--kls-nav-w)-16px)] shrink-0 items-center gap-2" aria-label="Sales-Portal – Startseite">
        <BrandMark />
      </Link>
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-[15px] font-semibold tracking-[-0.01em] whitespace-nowrap text-fg">Sales-Portal</span>
        {calls && <CallStatus />}
      </div>
      {/* The search shrinks (340 → 200 px) instead of pushing counters and the user menu out at 1280 px. */}
      <div className="flex min-w-0 flex-1 justify-center">
        <div className="flex w-full max-w-[340px] min-w-[200px] justify-center *:w-full">
          <CallbackSearch />
        </div>
      </div>
      <div className="flex min-w-0 shrink-0 items-center gap-3">
        <Counters />
        <span className="h-5 w-px bg-border" aria-hidden />
        <EnvironmentBadge />
        <UserMenu />
      </div>
    </header>
  );
}
