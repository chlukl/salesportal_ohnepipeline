/**
 * Admin (INTENT 6.14): Rollen, «Ansicht als», Ergebnisgruppen-Editor, Vorlagen, Einwände, Terminregeln, Einstellungen,
 * Verbindungen/Zugänge, Protokoll, Fehler. Mounted at /admin/* – each area has its own URL (/admin/protokoll …).
 * The server enforces admin rights on every call (also while «Ansicht als» is active).
 */
import type { MeResponse } from '@sales-portal/shared';
import { useNavigate, useParams } from 'react-router';
import { useAuth } from '@/app/auth';
import { useShortcut } from '@/app/shortcuts';
import { Badge, PageHeader, Tabs } from '@/components/ui';
import { BookingRulesTab, ConnectionsTab, SettingsTab } from './ConfigTabs';
import { AuditTab, ErrorsTab } from './LogTabs';
import { RolesTab } from './RolesTab';
import { RulesTab } from './RulesTab';
import { ObjectionsTab, TemplatesTab } from './TextsTabs';

const TABS = [
  { id: 'rollen', label: 'Rollen', Component: RolesTab },
  { id: 'ergebnisgruppen', label: 'Ergebnisgruppen', Component: RulesTab },
  { id: 'vorlagen', label: 'Vorlagen', Component: TemplatesTab },
  { id: 'einwaende', label: 'Einwände', Component: ObjectionsTab },
  { id: 'terminregeln', label: 'Terminregeln', Component: BookingRulesTab },
  { id: 'einstellungen', label: 'Einstellungen', Component: SettingsTab },
  { id: 'verbindungen', label: 'Verbindungen', Component: ConnectionsTab },
  { id: 'protokoll', label: 'Protokoll', Component: AuditTab },
  { id: 'fehler', label: 'Fehler', Component: ErrorsTab },
] as const;
type TabId = (typeof TABS)[number]['id'];

const ENV_TONE: Record<MeResponse['environment']['label'], 'danger' | 'warning' | 'info'> = { Prod: 'danger', Sandbox: 'warning', Demo: 'info' };

export default function AdminPage() {
  const params = useParams();
  const navigate = useNavigate();
  const { me } = useAuth();
  const slug = (params['*'] ?? '').split('/')[0];
  const index = Math.max(0, TABS.findIndex((t) => t.id === slug));
  const tab = TABS[index];
  const go = (id: TabId) => navigate(`/admin/${id}`, { replace: true });

  // «.» / «,» are plain keys on the Swiss and the US layout («[» / «]» need AltGr on CH and never fired).
  useShortcut('.', () => go(TABS[(index + 1) % TABS.length].id), { description: 'Nächster Admin-Bereich', group: 'Admin' });
  useShortcut(',', () => go(TABS[(index - 1 + TABS.length) % TABS.length].id), { description: 'Vorheriger Admin-Bereich', group: 'Admin' });

  const Component = tab.Component;
  return (
    <>
      <PageHeader
        title="Admin"
        description="Rollen, Regeln, Vorlagen und Protokoll des Portals. Jede Änderung wird protokolliert."
        actions={
          <span className="flex items-center gap-2 text-sm text-fg-muted">
            Umgebung
            <Badge size="md" tone={ENV_TONE[me.environment.label]}>
              {me.environment.label}
            </Badge>
            {me.environment.integrations !== 'live' && <Badge size="md">{me.environment.integrations === 'mock' ? 'simuliert' : 'teilweise simuliert'}</Badge>}
          </span>
        }
      />
      <Tabs items={TABS.map((t) => ({ id: t.id, label: t.label }))} value={tab.id} onChange={go} label="Admin-Bereiche" className="mb-5" />
      <div role="tabpanel" aria-label={tab.label}>
        <Component />
      </div>
    </>
  );
}
