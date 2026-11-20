/** Filter bar + «Weitere Filter» drawer of the Anrufliste (INTENT 6.1). Everything maps 1:1 to `LeadQuery`. */
import {
  CANTONS,
  CONTACT_ROLE_LABELS,
  EMPLOYEE_BANDS,
  OPTION_SETS,
  ORG_TYPE_LABELS,
  type ContactRole,
  type DueFilter,
  type EmployeeBand,
  type Grade,
  type OrgType,
} from '@sales-portal/shared';
import { useQuery } from '@tanstack/react-query';
import { RotateCcw, Search, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/app/api';
import { useAuth } from '@/app/auth';
import { Badge, Button, Checkbox, Drawer, Input, MultiSelect, Select } from '@/components/ui';
import { countFilters, type ListFilter } from './listQuery';

interface FilterOptions {
  industries: string[];
  customIndustries: string[];
  cantons: string[];
  subjects: string[];
  owners: { id: string; fullname: string }[];
  campaigns: string[];
}

export const GRADE_OPTIONS: { value: Grade; label: string }[] = [
  { value: 'A', label: 'A (ab 70)' },
  { value: 'B', label: 'B (50–69)' },
  { value: 'C', label: 'C (30–49)' },
  { value: 'D', label: 'D (unter 30)' },
  { value: 'unrated', label: 'unbewertet' },
];

const DUE_OPTIONS: { value: DueFilter | ''; label: string }[] = [
  { value: '', label: 'Fälligkeit: alle' },
  { value: 'overdue', label: 'Überfällig' },
  { value: 'today', label: 'Heute fällig' },
  { value: 'this_week', label: 'Diese Woche fällig' },
  { value: 'any_open', label: 'Mit offener Aufgabe' },
  { value: 'none', label: 'Ohne Aufgabe' },
];

const STATUS_REASONS = [1, 2, 845140001];
const opt = (set: keyof typeof OPTION_SETS, filter?: (code: number) => boolean) =>
  OPTION_SETS[set].filter((o) => !o.deprecated && (!filter || filter(o.code))).map((o) => ({ value: o.code, label: o.label }));

/** Keys that live in the drawer (for the badge count). */
const DRAWER_KEYS: (keyof ListFilter)[] = [
  'scoreMin',
  'scoreMax',
  'customIndustries',
  'excludeIndustries',
  'orgTypes',
  'cantons',
  'plzPrefixes',
  'ratingCategories',
  'statusCodes',
  'noContactSinceDays',
  'subjects',
  'leadSources',
  'leadSupport',
  'campaign',
  'campaignNames',
  'contactRoles',
  'decisionMaker',
  'ownerIds',
  'requireEmail',
  'includeHidden',
];

export function useFilterOptions() {
  return useQuery({ queryKey: ['leads', 'options'], queryFn: () => api.get<FilterOptions>('/api/leads/options'), staleTime: 10 * 60_000 });
}

export interface FilterBarProps {
  value: ListFilter;
  onChange: (next: ListFilter) => void;
  onReset: () => void;
  trailing?: ReactNode;
}

/** Search with a short debounce so typing does not fire a request per key. */
function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return;
    const id = window.setTimeout(() => onChange(text), 250);
    return () => window.clearTimeout(id);
  }, [text, value, onChange]);
  return (
    <Input
      icon={Search}
      placeholder="Firma, Person, Ort, Nummer …"
      value={text}
      onChange={(e) => setText(e.target.value)}
      className="w-64"
      aria-label="Anrufliste durchsuchen"
    />
  );
}

export function FilterBar({ value, onChange, onReset, trailing }: FilterBarProps) {
  const [open, setOpen] = useState(false);
  const options = useFilterOptions().data;
  const set = <K extends keyof ListFilter>(key: K, v: ListFilter[K]) => onChange({ ...value, [key]: v });
  const more = countFilters(value, DRAWER_KEYS) + (value.requirePhone === false ? 1 : 0) + (value.hideRetryPending === false ? 1 : 0);
  const anyActive = countFilters(value, ['search', 'grades', 'employeeBands', 'industries', 'due', 'callStatuses']) + more > 0;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <SearchBox value={value.search ?? ''} onChange={(v) => set('search', v || undefined)} />
      <MultiSelect label="Grade" options={GRADE_OPTIONS} value={(value.grades ?? []) as Grade[]} onChange={(v) => set('grades', v)} />
      <MultiSelect
        label="Mitarbeitende"
        options={EMPLOYEE_BANDS.map((b) => ({ value: b.key, label: b.label }))}
        value={(value.employeeBands ?? []) as EmployeeBand[]}
        onChange={(v) => set('employeeBands', v)}
      />
      <MultiSelect label="Branche" options={(options?.industries ?? []).map((i) => ({ value: i, label: i }))} value={value.industries ?? []} onChange={(v) => set('industries', v)} />
      <MultiSelect label="Anrufstatus" options={opt('kls_callstatus')} value={value.callStatuses ?? []} onChange={(v) => set('callStatuses', v)} />
      <Select
        aria-label="Fälligkeit"
        options={DUE_OPTIONS}
        value={value.due ?? ''}
        onChange={(e) => set('due', (e.target.value || undefined) as DueFilter | undefined)}
        className="w-48"
      />
      <Button icon={SlidersHorizontal} onClick={() => setOpen(true)}>
        Weitere Filter
        {more > 0 && (
          <Badge tone="primary" className="ml-0.5">
            {more}
          </Badge>
        )}
      </Button>
      {anyActive && (
        <Button variant="ghost" icon={RotateCcw} onClick={onReset}>
          Zurücksetzen
        </Button>
      )}
      <div className="ml-auto flex items-center gap-2">{trailing}</div>
      <MoreFilters open={open} onClose={() => setOpen(false)} value={value} onChange={onChange} options={options} />
    </div>
  );
}

function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <section className="space-y-2.5 border-b border-border pb-5 last:border-b-0">
      <div>
        <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
        {hint && <p className="text-xs text-fg-subtle">{hint}</p>}
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </section>
  );
}

function MoreFilters({
  open,
  onClose,
  value,
  onChange,
  options,
}: {
  open: boolean;
  onClose: () => void;
  value: ListFilter;
  onChange: (f: ListFilter) => void;
  options?: FilterOptions;
}) {
  const { me, hasRole } = useAuth();
  const set = <K extends keyof ListFilter>(key: K, v: ListFilter[K]) => onChange({ ...value, [key]: v });
  const num = (s: string) => (s.trim() === '' ? undefined : Number(s));
  const myCrm = me.user.crmUserId;
  const ownerMode = !value.ownerIds?.length ? 'all' : myCrm && value.ownerIds.length === 1 && value.ownerIds[0] === myCrm ? 'mine' : 'custom';
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Weitere Filter"
      description="Wirken sofort auf die Liste. Speichern über «Filter speichern»."
      width={520}
      footer={
        <Button variant="primary" onClick={onClose}>
          Fertig
        </Button>
      }
    >
      <div className="space-y-5">
        <Section title="Score" hint="Lead-Score: A ab 70, B ab 50, C ab 30">
          <Input aria-label="Score ab" type="number" min={0} max={100} placeholder="ab" className="w-28" value={value.scoreMin ?? ''} onChange={(e) => set('scoreMin', num(e.target.value))} />
          <Input aria-label="Score bis" type="number" min={0} max={100} placeholder="bis" className="w-28" value={value.scoreMax ?? ''} onChange={(e) => set('scoreMax', num(e.target.value))} />
        </Section>
        <Section title="Branche und Firma">
          <MultiSelect label="Branche ausschliessen" options={(options?.industries ?? []).map((i) => ({ value: i, label: i }))} value={value.excludeIndustries ?? []} onChange={(v) => set('excludeIndustries', v)} />
          <MultiSelect label="Eigene Kategorie" options={(options?.customIndustries ?? []).map((i) => ({ value: i, label: i }))} value={value.customIndustries ?? []} onChange={(v) => set('customIndustries', v)} />
          <MultiSelect
            label="Organisationstyp"
            options={(Object.keys(ORG_TYPE_LABELS) as OrgType[]).map((k) => ({ value: k, label: ORG_TYPE_LABELS[k] }))}
            value={(value.orgTypes ?? []) as OrgType[]}
            onChange={(v) => set('orgTypes', v)}
          />
        </Section>
        <Section title="Region">
          <MultiSelect
            label="Kanton"
            options={(options?.cantons.length ? options.cantons : Object.keys(CANTONS)).map((c) => ({ value: c, label: `${c} · ${CANTONS[c] ?? c}` }))}
            value={value.cantons ?? []}
            onChange={(v) => set('cantons', v)}
          />
          <Input
            aria-label="PLZ-Bereich"
            placeholder="PLZ beginnt mit, z. B. 40, 41"
            className="w-64"
            value={(value.plzPrefixes ?? []).join(', ')}
            onChange={(e) =>
              set(
                'plzPrefixes',
                e.target.value
                  .split(/[,\s]+/)
                  .map((s) => s.trim())
                  .filter((s) => /^\d{1,4}$/.test(s)),
              )
            }
          />
        </Section>
        <Section title="Stand im CRM">
          <MultiSelect label="Einschätzung Verkauf" options={opt('kls_rating_category')} value={value.ratingCategories ?? []} onChange={(v) => set('ratingCategories', v)} />
          <MultiSelect label="Stand (Neu, Kontaktiert …)" options={opt('statuscode', (c) => STATUS_REASONS.includes(c))} value={value.statusCodes ?? []} onChange={(v) => set('statusCodes', v)} />
          <Select
            aria-label="Letzter Kontakt"
            className="w-60"
            value={value.noContactSinceDays != null ? String(value.noContactSinceDays) : ''}
            onChange={(e) => set('noContactSinceDays', num(e.target.value))}
            options={[
              { value: '', label: 'Letzter Kontakt: egal' },
              { value: '30', label: 'seit über 30 Tagen kein Kontakt' },
              { value: '90', label: 'seit über 3 Monaten kein Kontakt' },
              { value: '180', label: 'seit über 6 Monaten kein Kontakt' },
            ]}
          />
        </Section>
        <Section title="Thema und Quelle">
          <MultiSelect label="Thema" options={(options?.subjects ?? []).map((s) => ({ value: s, label: s }))} value={value.subjects ?? []} onChange={(v) => set('subjects', v)} />
          <MultiSelect label="Quelle" options={opt('leadsourcecode')} value={value.leadSources ?? []} onChange={(v) => set('leadSources', v)} />
          <MultiSelect label="Zuständig (Verkauf, Marketing …)" options={opt('kls_lead_support')} value={value.leadSupport ?? []} onChange={(v) => set('leadSupport', v)} />
        </Section>
        <Section title="Automatisierte Kampagne" hint="Kampagnen-Leads erscheinen erst nach 3 Monaten ohne Aktivität (Abzeichen «aus Kampagne»).">
          <Select
            aria-label="Kampagne"
            className="w-72"
            value={value.campaign ?? 'exclude_locked'}
            onChange={(e) => set('campaign', e.target.value === 'exclude_locked' ? undefined : (e.target.value as ListFilter['campaign']))}
            options={[
              { value: 'exclude_locked', label: 'Gesperrte ausblenden (Standard)' },
              { value: 'only_from_campaign', label: 'Nur «aus Kampagne» (entsperrt)' },
              ...(hasRole('admin') ? [{ value: 'only_locked', label: 'Nur gesperrte (Admin)' }, { value: 'all', label: 'Alle (Admin)' }] : []),
            ]}
          />
          {!!options?.campaigns.length && (
            <MultiSelect label="Kampagne" options={options.campaigns.map((c) => ({ value: c, label: c }))} value={value.campaignNames ?? []} onChange={(v) => set('campaignNames', v)} />
          )}
        </Section>
        <Section title="Ansprechperson">
          <MultiSelect
            label="Rolle"
            options={(Object.keys(CONTACT_ROLE_LABELS) as ContactRole[]).map((k) => ({ value: k, label: CONTACT_ROLE_LABELS[k] }))}
            value={(value.contactRoles ?? []) as ContactRole[]}
            onChange={(v) => set('contactRoles', v)}
          />
          <Checkbox label="Nur Entscheider" checked={value.decisionMaker === true} onChange={(e) => set('decisionMaker', e.target.checked ? true : undefined)} />
        </Section>
        <Section title="Erreichbarkeit" hint="Ohne gültige Nummer kommt ein Lead nicht in die Liste («Nummer prüfen» im Arbeitsplatz).">
          <div className="w-full space-y-2">
            <Checkbox
              label="Nur mit gültiger Telefonnummer"
              checked={value.requirePhone !== false}
              onChange={(e) => set('requirePhone', e.target.checked ? undefined : false)}
            />
            <Checkbox label="Nur mit E-Mail-Adresse" checked={value.requireEmail === true} onChange={(e) => set('requireEmail', e.target.checked ? true : undefined)} />
            <Checkbox
              label="«Nicht erreicht» erst im nächsten Halbtag wieder zeigen"
              checked={value.hideRetryPending !== false}
              onChange={(e) => set('hideRetryPending', e.target.checked ? undefined : false)}
            />
          </div>
        </Section>
        <Section title="Besitzer">
          <Select
            aria-label="Besitzer"
            className="w-60"
            value={ownerMode}
            onChange={(e) => set('ownerIds', e.target.value === 'mine' && myCrm ? [myCrm] : undefined)}
            options={[
              { value: 'all', label: 'Alle Besitzer' },
              ...(myCrm ? [{ value: 'mine', label: 'Nur meine Leads' }] : []),
              ...(ownerMode === 'custom' ? [{ value: 'custom', label: 'Auswahl' }] : []),
            ]}
          />
          <MultiSelect label="Besitzer wählen" options={(options?.owners ?? []).map((o) => ({ value: o.id, label: o.fullname }))} value={value.ownerIds ?? []} onChange={(v) => set('ownerIds', v)} />
        </Section>
        {hasRole('admin') && (
          <Section title="Admin">
            <Checkbox
              label="Auch ausgeblendete Leads zeigen"
              description="Geschlossen, Divendo, Zweitkontakt, nicht mehr kontaktieren, bestehende Firma …"
              checked={value.includeHidden === true}
              onChange={(e) => set('includeHidden', e.target.checked ? true : undefined)}
            />
          </Section>
        )}
      </div>
    </Drawer>
  );
}
