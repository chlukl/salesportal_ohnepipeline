/** Shared helpers of the admin pages: CRM value display (codes only here), action labels, save shortcut. */
import { OPTION_SETS, optionLabelWithCode, type OptionSetName } from '@sales-portal/shared';
import type { ReactNode } from 'react';
import { useShortcut } from '@/app/shortcuts';
import { Card, CardHeader } from '@/components/ui';

/** Lead / activity fields that hold option-set codes (admin view shows label + code). */
export const FIELD_OPTION_SET: Record<string, OptionSetName> = {
  kls_callstatus: 'kls_callstatus',
  kls_rating_category: 'kls_rating_category',
  statuscode: 'statuscode',
  statecode: 'statecode',
  kls_lead_support: 'kls_lead_support',
  kls_interests: 'kls_interests',
  leadsourcecode: 'leadsourcecode',
  kls_salutation: 'kls_salutation',
  kls_anrufergebnis: 'kls_anrufergebnis',
  kls_interesse: 'kls_interesse',
};

/** Plain-text display of any stored value (never rendered as HTML). */
export function displayValue(field: string | null | undefined, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'leer';
  const set = field ? FIELD_OPTION_SET[field] : undefined;
  if (set && typeof value === 'number') return optionLabelWithCode(set, value) ?? String(value);
  if (set && Array.isArray(value)) return value.map((v) => (typeof v === 'number' ? (optionLabelWithCode(set, v) ?? String(v)) : String(v))).join(', ') || 'leer';
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  try {
    const s = JSON.stringify(value);
    return s.length > 300 ? `${s.slice(0, 300)} …` : s;
  } catch {
    return '…';
  }
}

export function optionChoices(set: OptionSetName, opts: { includeDeprecated?: boolean } = {}) {
  return OPTION_SETS[set]
    .filter((o) => opts.includeDeprecated || !o.deprecated)
    .map((o) => ({ value: String(o.code), label: `${o.label} (${o.code})${o.assumed ? ' · zu prüfen' : ''}` }));
}

export const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Anmeldung',
  'auth.logout': 'Abmeldung',
  'me.view_as': 'Ansicht als',
  'admin.role_grant': 'Rolle vergeben',
  'admin.role_revoke': 'Rolle entfernt',
  'admin.user_create': 'Person hinzugefügt',
  'admin.user_activate': 'Zugang aktiviert',
  'admin.user_deactivate': 'Zugang gesperrt',
  'admin.rule_version': 'Ergebnisgruppe: neue Version',
  'admin.template_update': 'Vorlage geändert',
  'admin.objection_create': 'Einwand hinzugefügt',
  'admin.objection_update': 'Einwand geändert',
  'admin.use_case_create': 'Use Case hinzugefügt',
  'admin.use_case_update': 'Use Case geändert',
  'admin.setting_update': 'Einstellung geändert',
  'admin.revert_proposed': 'Zurücksetzen vorgeschlagen',
  'admin.job_retry': 'Job neu gestartet',
  'admin.secret_expiry_notice': 'Warnung Ablaufdatum',
  'crm.field_update': 'CRM-Feld geändert',
  'crm.note_create': 'CRM-Notiz erstellt',
  'crm.phonecall_update': 'Telefonaktivität ergänzt',
  'crm.task_complete': 'Aufgabe erledigt',
  'crm.task_reschedule': 'Aufgabe verschoben',
  'dashboard.weekly_report_sent': 'Wochenreport gesendet',
  'transcripts.retention_delete': 'Transkripte gelöscht (Frist)',
};

export const actionLabel = (a: string) => ACTION_LABELS[a] ?? a;

export function useSaveShortcut(save: () => void, enabled: boolean, description = 'Speichern') {
  useShortcut('mod+s', (e) => {
    e.preventDefault();
    save();
  }, { description, group: 'Admin', allowInInput: true, enabled });
}

export function Section({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader title={title} description={description} actions={actions} />
      {children}
    </Card>
  );
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('de-CH', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Zurich' }).format(new Date(iso));
}
