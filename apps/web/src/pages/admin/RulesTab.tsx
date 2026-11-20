/**
 * Ergebnisgruppen-Editor (INTENT 6.5 «Wie es gebaut wird»): jede Gruppe ist eine Regel mit Feldaktionen.
 * Speichern erzeugt eine NEUE Version (alte bleiben, Dashboard weiss, mit welcher Regel ein Anruf gespeichert wurde).
 * CRM-Codes sind nur hier sichtbar (Label + Code).
 */
import {
  OPTION_SETS,
  type FieldAction,
  type FieldActionKind,
  type LeadFieldName,
  type ResultGroupKey,
  type ResultGroupRule,
  type ResultGroupRuleVersion,
  type ResultInput,
  type RuleCondition,
} from '@sales-portal/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, History, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, errorMessage } from '@/app/api';
import { toast } from '@/app/toast';
import { Badge, Button, Card, CardBody, CardHeader, cn, Dialog, EmptyState, IconButton, Input, Select, SkeletonText, Textarea, Toggle } from '@/components/ui';
import { formatDateTime, optionChoices, useSaveShortcut } from './common';

type FieldType = 'text' | 'number' | 'boolean' | 'option' | 'multioption';
interface FieldMeta {
  field: LeadFieldName;
  label: string;
  type: FieldType;
  optionSet?: keyof typeof OPTION_SETS;
}
type InputKey = keyof ResultInput;
interface RulesResponse {
  items: (ResultGroupRuleVersion & { versionCount: number })[];
  meta: { fields: FieldMeta[]; inputs: { key: InputKey; label: string }[] };
}

const ACTION_KINDS: { value: FieldActionKind; label: string }[] = [
  { value: 'set', label: 'setzen' },
  { value: 'add_to_multiselect', label: 'zu Mehrfachauswahl hinzufügen' },
  { value: 'set_if_empty', label: 'nur wenn leer' },
  { value: 'disqualify', label: 'disqualifizieren mit Statusgrund' },
  { value: 'note', label: 'Notiz' },
  { value: 'task', label: 'Aufgabe' },
  { value: 'research', label: 'Research-Auftrag' },
];

const CONDITION_KINDS: { value: RuleCondition['kind']; label: string }[] = [
  { value: 'always', label: 'immer' },
  { value: 'interest_gte', label: 'wenn Interesse mindestens' },
  { value: 'employees_lt', label: 'wenn Mitarbeitende unter' },
  { value: 'employees_gte', label: 'wenn Mitarbeitende ab' },
  { value: 'input_true', label: 'wenn Eingabe «Ja»' },
  { value: 'input_present', label: 'wenn Eingabe vorhanden' },
  { value: 'input_absent', label: 'wenn Eingabe fehlt' },
];

const FOLLOW_UP: { value: ResultGroupRule['followUp']['type']; label: string }[] = [
  { value: 'none', label: 'keine' },
  { value: 'task', label: 'Aufgabe' },
  { value: 'mail', label: 'Mail' },
  { value: 'booking', label: 'Termin' },
  { value: 'research', label: 'Research-Auftrag' },
];

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const numOrUndef = (v: string) => (v.trim() === '' ? undefined : Number(v));

export function RulesTab() {
  const rules = useQuery({ queryKey: ['admin', 'rules'], queryFn: () => api.get<RulesResponse>('/api/admin/rules') });
  const [selected, setSelected] = useState<ResultGroupKey | null>(null);
  const current = rules.data?.items.find((r) => r.key === selected) ?? rules.data?.items[0];

  if (rules.isLoading) return <SkeletonText lines={8} />;
  if (!rules.data?.items.length) return <EmptyState title="Keine Ergebnisgruppen" description="Die Standardregeln werden beim Start angelegt. Bitte Server-Protokoll prüfen." />;

  return (
    <div className="grid grid-cols-[300px_1fr] gap-5">
      <Card className="h-fit overflow-hidden">
        <CardHeader title="Ergebnisgruppen" description="Reihenfolge wie bei der Nachbearbeitung" />
        <ul className="pb-2">
          {rules.data.items.map((r) => (
            <li key={r.key}>
              <button
                type="button"
                onClick={() => setSelected(r.key)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 px-5 py-2 text-left text-sm transition-colors',
                  current?.key === r.key ? 'bg-primary-subtle text-primary' : 'text-fg hover:bg-surface-2',
                )}
              >
                <span className={cn('truncate', !r.definition.active && 'text-fg-subtle line-through')}>{r.label}</span>
                <span className="tabular shrink-0 text-xs text-fg-subtle">v{r.version}</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      {current && <RuleEditor key={`${current.key}:${current.version}`} rule={current} meta={rules.data.meta} />}
    </div>
  );
}

function RuleEditor({ rule, meta }: { rule: ResultGroupRuleVersion & { versionCount: number }; meta: RulesResponse['meta'] }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ResultGroupRule>(() => clone(rule.definition));
  const [historyOpen, setHistoryOpen] = useState(false);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(rule.definition), [draft, rule.definition]);

  const save = useMutation({
    mutationFn: () => api.put<ResultGroupRuleVersion>(`/api/admin/rules/${rule.key}`, { definition: draft }),
    onSuccess: (v) => {
      toast.success(`Version ${v.version} von «${v.label}» gespeichert`, { description: 'Neue Anrufe verwenden ab jetzt diese Version.' });
      void qc.invalidateQueries({ queryKey: ['admin', 'rules'] });
    },
    onError: (err) => toast.error('Nicht gespeichert', { description: errorMessage(err), duration: 10_000 }),
  });
  useSaveShortcut(() => dirty && !save.isPending && save.mutate(), true, 'Regel als neue Version speichern');

  const set = <K extends keyof ResultGroupRule>(k: K, v: ResultGroupRule[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const inputOptions = meta.inputs.map((i) => ({ value: i.key, label: i.label }));

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              {rule.label}
              <Badge>Version {rule.version}</Badge>
              {dirty && <Badge tone="warning">ungespeichert</Badge>}
            </span>
          }
          description={`Zuletzt gespeichert ${formatDateTime(rule.createdAt)}${rule.createdByName ? ` von ${rule.createdByName}` : ' (Standard)'} · ${rule.versionCount} Version${rule.versionCount === 1 ? '' : 'en'}`}
          actions={
            <>
              <Button variant="ghost" icon={History} onClick={() => setHistoryOpen(true)}>
                Versionen
              </Button>
              {dirty && (
                <Button variant="ghost" icon={RotateCcw} onClick={() => setDraft(clone(rule.definition))}>
                  Verwerfen
                </Button>
              )}
              <Button variant="primary" icon={Save} kbd="Ctrl S" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
                Als neue Version speichern
              </Button>
            </>
          }
        />
        <CardBody className="grid grid-cols-2 gap-4">
          <Input label="Name (so sieht ihn Markus)" value={draft.label} onChange={(e) => set('label', e.target.value)} maxLength={80} />
          <Select
            label="Anrufergebnis an der Telefonaktivität"
            value={String(draft.anrufergebnis)}
            options={optionChoices('kls_anrufergebnis')}
            onChange={(e) => set('anrufergebnis', Number(e.target.value))}
          />
          <Textarea className="col-span-2" label="Beschreibung (optional)" rows={2} value={draft.description ?? ''} onChange={(e) => set('description', e.target.value || undefined)} maxLength={500} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Anrufstatus, Bewertung, Status" />
        <CardBody className="space-y-4">
          <CallStatusEditor rule={draft} onChange={(cs) => set('callStatus', cs)} />
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Bewertung Sales"
              value={draft.ratingCategory ? String(draft.ratingCategory.value) : ''}
              placeholder="– nicht setzen –"
              options={optionChoices('kls_rating_category')}
              onChange={(e) => set('ratingCategory', e.target.value ? { ...(draft.ratingCategory ?? {}), value: Number(e.target.value) } : null)}
            />
            {draft.ratingCategory && (
              <ConditionEditor
                label="Bewertung nur"
                value={draft.ratingCategory.condition}
                inputs={inputOptions}
                onChange={(c) => set('ratingCategory', { ...draft.ratingCategory!, condition: c })}
              />
            )}
            <Select
              label="Status des Leads"
              value={draft.state ?? 'keep'}
              options={[
                { value: 'keep', label: 'bleibt wie er ist' },
                { value: 'contacted', label: 'Neu → Kontaktiert' },
              ]}
              onChange={(e) => set('state', e.target.value as 'keep' | 'contacted')}
            />
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 pt-1">
            <Toggle label="Besitzer wird die anrufende Person" checked={draft.setsOwnerToCaller} onChange={(v) => set('setsOwnerToCaller', v)} />
            <Toggle label="Setzt «Kontaktiert»" checked={draft.setsContacted} onChange={(v) => set('setsContacted', v)} />
            <Toggle label="Zählt als echter Kontakt" description="jemand wurde erreicht" checked={draft.isRealContact} onChange={(v) => set('isRealContact', v)} />
            <Toggle label="Gruppe aktiv" description="inaktive Gruppen sieht Markus nicht" checked={draft.active} onChange={(v) => set('active', v)} />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Feldaktionen"
          description="Werden in dieser Reihenfolge in die Vorschau übernommen. Geschrieben wird nach der Freigabe: Notiz → Felder → Status."
          actions={
            <Button icon={Plus} onClick={() => set('fieldActions', [...draft.fieldActions, { kind: 'set', field: meta.fields[0].field, value: null }])}>
              Aktion hinzufügen
            </Button>
          }
        />
        <CardBody className="space-y-3">
          {draft.fieldActions.length === 0 && <p className="text-sm text-fg-subtle">Keine Feldaktionen – nur Anrufstatus, Bewertung und Folgeaktion.</p>}
          {draft.fieldActions.map((a, i) => (
            <FieldActionRow
              key={i}
              action={a}
              meta={meta}
              index={i}
              count={draft.fieldActions.length}
              onChange={(next) => set('fieldActions', draft.fieldActions.map((x, j) => (j === i ? next : x)))}
              onMove={(dir) => {
                const list = [...draft.fieldActions];
                const [item] = list.splice(i, 1);
                list.splice(i + dir, 0, item);
                set('fieldActions', list);
              }}
              onRemove={() => set('fieldActions', draft.fieldActions.filter((_, j) => j !== i))}
            />
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Folgeaktion und Eingaben" description="Aufgaben immer nach der Aufgaben-Regel (keine 2. offene Aufgabe pro Firma, max. 3 pro Person und Tag)." />
        <CardBody className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <Select label="Folgeaktion" value={draft.followUp.type} options={FOLLOW_UP} onChange={(e) => set('followUp', { ...draft.followUp, type: e.target.value as ResultGroupRule['followUp']['type'] })} />
            <Input label="nach Tagen" type="number" min={0} value={draft.followUp.offsetDays ?? ''} onChange={(e) => set('followUp', { ...draft.followUp, offsetDays: numOrUndef(e.target.value) })} />
            <Input label="nach Arbeitstagen" type="number" min={0} value={draft.followUp.offsetWorkdays ?? ''} onChange={(e) => set('followUp', { ...draft.followUp, offsetWorkdays: numOrUndef(e.target.value) })} />
            <Select
              label="Fällig am (aus Eingabe)"
              value={draft.followUp.dueFrom ?? ''}
              placeholder="– nicht aus Eingabe –"
              options={inputOptions}
              onChange={(e) => set('followUp', { ...draft.followUp, dueFrom: (e.target.value || undefined) as InputKey | undefined })}
            />
            <Input label="Betreff der Aufgabe" hint="Platzhalter: {company}" value={draft.followUp.taskSubject ?? ''} onChange={(e) => set('followUp', { ...draft.followUp, taskSubject: e.target.value || undefined })} />
            <Input label="Hinweis für Markus" value={draft.followUp.hint ?? ''} onChange={(e) => set('followUp', { ...draft.followUp, hint: e.target.value || undefined })} />
          </div>
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-fg">Eingaben in der Nachbearbeitung</legend>
            <div className="flex flex-wrap gap-2">
              {meta.inputs.map((inp) => {
                const on = draft.inputs?.includes(inp.key) ?? false;
                return (
                  <button
                    key={inp.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => set('inputs', on ? (draft.inputs ?? []).filter((x) => x !== inp.key) : [...(draft.inputs ?? []), inp.key])}
                    className={cn('rounded-full border px-3 py-1 text-[13px] transition-colors', on ? 'border-primary bg-primary-subtle text-primary' : 'border-border-strong text-fg-muted hover:text-fg')}
                  >
                    {inp.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <div className="grid grid-cols-3 gap-4">
            <Input label="Tastaturkürzel" maxLength={1} value={draft.shortcut ?? ''} onChange={(e) => set('shortcut', e.target.value.toLowerCase() || undefined)} hint="ein Buchstabe oder eine Ziffer" />
            <Input label="Reihenfolge" type="number" min={0} value={draft.sortOrder} onChange={(e) => set('sortOrder', Number(e.target.value) || 0)} />
          </div>
        </CardBody>
      </Card>

      <VersionsDialog open={historyOpen} onClose={() => setHistoryOpen(false)} ruleKey={rule.key} />
    </div>
  );
}

function CallStatusEditor({ rule, onChange }: { rule: ResultGroupRule; onChange: (cs: ResultGroupRule['callStatus']) => void }) {
  const cs = rule.callStatus;
  const statusOptions = optionChoices('kls_callstatus');
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-4">
        <Select
          label="Anrufstatus"
          value={cs.mode}
          options={[
            { value: 'none', label: 'nicht ändern' },
            { value: 'fixed', label: 'fester Wert' },
            { value: 'by_date', label: 'nach Datum (Rückruf / später)' },
          ]}
          onChange={(e) => {
            const mode = e.target.value as typeof cs.mode;
            onChange(mode === 'by_date' ? { mode, byDate: cs.byDate?.length ? cs.byDate : [{ maxDays: null, value: Number(statusOptions[0].value) }] } : mode === 'fixed' ? { mode, value: cs.value ?? Number(statusOptions[0].value) } : { mode });
          }}
        />
        {cs.mode === 'fixed' && <Select label="Wert" value={String(cs.value ?? '')} options={statusOptions} onChange={(e) => onChange({ ...cs, value: Number(e.target.value) })} />}
      </div>
      {cs.mode === 'by_date' && (
        <div className="rounded-md border border-border p-3">
          <p className="mb-2 text-xs text-fg-muted">Von oben nach unten: die erste Stufe, deren Tagesgrenze das gewählte Datum einschliesst, gilt (0 = heute). Die letzte Stufe gilt für alles Spätere.</p>
          {(cs.byDate ?? []).map((step, i, list) => (
            <div key={i} className="mb-2 grid grid-cols-[160px_1fr_auto] items-end gap-3">
              <Input
                label={i === 0 ? 'bis Tage' : undefined}
                inputSize="sm"
                type="number"
                min={0}
                placeholder="später"
                value={step.maxDays ?? ''}
                onChange={(e) => onChange({ ...cs, byDate: list.map((s, j) => (j === i ? { ...s, maxDays: e.target.value === '' ? null : Number(e.target.value) } : s)) })}
              />
              <Select label={i === 0 ? 'Anrufstatus' : undefined} selectSize="sm" value={String(step.value)} options={statusOptions} onChange={(e) => onChange({ ...cs, byDate: list.map((s, j) => (j === i ? { ...s, value: Number(e.target.value) } : s)) })} />
              <IconButton icon={Trash2} label="Stufe entfernen" size="sm" disabled={list.length === 1} onClick={() => onChange({ ...cs, byDate: list.filter((_, j) => j !== i) })} />
            </div>
          ))}
          <Button size="sm" variant="ghost" icon={Plus} onClick={() => onChange({ ...cs, byDate: [{ maxDays: 0, value: Number(statusOptions[0].value) }, ...(cs.byDate ?? [])] })}>
            Stufe hinzufügen
          </Button>
        </div>
      )}
    </div>
  );
}

function ConditionEditor({ label, value, inputs, onChange }: { label: string; value: RuleCondition | undefined; inputs: { value: string; label: string }[]; onChange: (c: RuleCondition | undefined) => void }) {
  const kind = value?.kind ?? 'always';
  const needsNumber = kind === 'interest_gte' || kind === 'employees_lt' || kind === 'employees_gte';
  const needsInput = kind === 'input_true' || kind === 'input_present' || kind === 'input_absent';
  return (
    <div className="grid grid-cols-[1fr_1fr] gap-2">
      <Select
        label={label}
        selectSize="sm"
        value={kind}
        options={CONDITION_KINDS}
        onChange={(e) => {
          const k = e.target.value as RuleCondition['kind'];
          if (k === 'always') onChange(undefined);
          else if (k === 'interest_gte' || k === 'employees_lt' || k === 'employees_gte') onChange({ kind: k, value: k === 'interest_gte' ? 2 : 5 });
          else onChange({ kind: k, input: (inputs[0]?.value ?? 'reason') as InputKey });
        }}
      />
      {needsNumber && value && 'value' in value && (
        <Input label="Wert" inputSize="sm" type="number" min={0} value={value.value} onChange={(e) => onChange({ ...value, value: Number(e.target.value) || 0 })} />
      )}
      {needsInput && value && 'input' in value && (
        <Select label="Eingabe" selectSize="sm" value={value.input} options={inputs} onChange={(e) => onChange({ ...value, input: e.target.value as InputKey })} />
      )}
    </div>
  );
}

function ValueEditor({ meta, action, onChange, inputs }: { meta: FieldMeta | undefined; action: FieldAction; onChange: (a: FieldAction) => void; inputs: { value: string; label: string }[] }) {
  const fromInput = !!action.valueFrom;
  return (
    <div className="grid grid-cols-[150px_1fr] gap-2">
      <Select
        label="Wert"
        selectSize="sm"
        value={fromInput ? 'input' : 'fixed'}
        options={[
          { value: 'fixed', label: 'fester Wert' },
          { value: 'input', label: 'aus Eingabe' },
        ]}
        onChange={(e) => onChange(e.target.value === 'input' ? { ...action, value: undefined, valueFrom: (inputs[0]?.value ?? 'reason') as InputKey } : { ...action, valueFrom: undefined, value: null })}
      />
      {fromInput ? (
        <Select label="Eingabe" selectSize="sm" value={action.valueFrom ?? ''} options={inputs} onChange={(e) => onChange({ ...action, valueFrom: e.target.value as InputKey })} />
      ) : meta?.optionSet ? (
        <Select label="Code" selectSize="sm" value={action.value == null ? '' : String(action.value)} placeholder="– wählen –" options={optionChoices(meta.optionSet)} onChange={(e) => onChange({ ...action, value: e.target.value ? Number(e.target.value) : null })} />
      ) : meta?.type === 'boolean' ? (
        <Select
          label="Ja/Nein"
          selectSize="sm"
          value={action.value === true ? 'true' : action.value === false ? 'false' : ''}
          placeholder="– wählen –"
          options={[
            { value: 'true', label: 'Ja' },
            { value: 'false', label: 'Nein' },
          ]}
          onChange={(e) => onChange({ ...action, value: e.target.value === '' ? null : e.target.value === 'true' })}
        />
      ) : meta?.type === 'number' ? (
        <Input label="Zahl" inputSize="sm" type="number" value={typeof action.value === 'number' ? action.value : ''} onChange={(e) => onChange({ ...action, value: e.target.value === '' ? null : Number(e.target.value) })} />
      ) : (
        <Input label="Text" inputSize="sm" maxLength={500} value={typeof action.value === 'string' ? action.value : ''} onChange={(e) => onChange({ ...action, value: e.target.value })} />
      )}
    </div>
  );
}

function FieldActionRow({
  action,
  meta,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  action: FieldAction;
  meta: RulesResponse['meta'];
  index: number;
  count: number;
  onChange: (a: FieldAction) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const inputs = meta.inputs.map((i) => ({ value: i.key, label: i.label }));
  const isFieldKind = action.kind === 'set' || action.kind === 'add_to_multiselect' || action.kind === 'set_if_empty';
  const fields = meta.fields.filter((f) => (action.kind === 'add_to_multiselect' ? f.type === 'multioption' : f.type !== 'multioption'));
  const fieldMeta = meta.fields.find((f) => f.field === action.field);
  return (
    <div className="rounded-md border border-border bg-surface-2/40 p-3">
      <div className="flex items-start gap-3">
        <span className="tabular mt-7 w-5 text-right text-xs text-fg-subtle">{index + 1}.</span>
        <div className="grid flex-1 grid-cols-2 gap-3">
          <Select
            label="Aktion"
            selectSize="sm"
            value={action.kind}
            options={ACTION_KINDS}
            onChange={(e) => {
              const kind = e.target.value as FieldActionKind;
              const base: FieldAction = { kind, condition: action.condition };
              if (kind === 'add_to_multiselect') onChange({ ...base, field: meta.fields.find((f) => f.type === 'multioption')?.field, value: null });
              else if (kind === 'set' || kind === 'set_if_empty') onChange({ ...base, field: meta.fields.find((f) => f.type !== 'multioption')?.field, value: null });
              else if (kind === 'disqualify') onChange({ ...base, statuscode: 6 });
              else if (kind === 'note') onChange({ ...base, text: 'Sales-Portal: ' });
              else if (kind === 'task') onChange({ ...base, taskSubject: 'Nachfassen {company}', offsetDays: 7 });
              else onChange(base);
            }}
          />
          {isFieldKind && (
            <Select
              label="Feld"
              selectSize="sm"
              value={action.field ?? ''}
              options={fields.map((f) => ({ value: f.field, label: `${f.label} (${f.field})` }))}
              onChange={(e) => onChange({ ...action, field: e.target.value as LeadFieldName, value: null, valueFrom: undefined })}
            />
          )}
          {isFieldKind && <ValueEditor meta={fieldMeta} action={action} onChange={onChange} inputs={inputs} />}
          {isFieldKind && <Input label="Bezeichnung in der Vorschau (optional)" inputSize="sm" value={action.label ?? ''} onChange={(e) => onChange({ ...action, label: e.target.value || undefined })} />}
          {action.kind === 'disqualify' && (
            <Select label="Statusgrund" selectSize="sm" value={String(action.statuscode ?? '')} options={optionChoices('statuscode')} onChange={(e) => onChange({ ...action, statuscode: Number(e.target.value) })} />
          )}
          {action.kind === 'note' && (
            <Textarea className="col-span-2" label="Notiz" rows={2} hint="Beginnt mit «Sales-Portal:». Platzhalter: {reason}, {company}, {caller}" value={action.text ?? ''} onChange={(e) => onChange({ ...action, text: e.target.value })} />
          )}
          {action.kind === 'task' && (
            <>
              <Input label="Betreff der Aufgabe" inputSize="sm" value={action.taskSubject ?? ''} onChange={(e) => onChange({ ...action, taskSubject: e.target.value })} />
              <div className="grid grid-cols-2 gap-2">
                <Input label="in Tagen" inputSize="sm" type="number" min={0} value={action.offsetDays ?? ''} onChange={(e) => onChange({ ...action, offsetDays: numOrUndef(e.target.value) })} />
                <Select label="oder Datum aus" selectSize="sm" value={action.dueFrom ?? ''} placeholder="–" options={inputs} onChange={(e) => onChange({ ...action, dueFrom: (e.target.value || undefined) as InputKey | undefined })} />
              </div>
            </>
          )}
          <ConditionEditor label="Bedingung" value={action.condition} inputs={inputs} onChange={(c) => onChange({ ...action, condition: c })} />
        </div>
        <div className="mt-6 flex flex-col gap-1">
          <IconButton icon={ArrowUp} label="Nach oben" size="sm" disabled={index === 0} onClick={() => onMove(-1)} />
          <IconButton icon={ArrowDown} label="Nach unten" size="sm" disabled={index === count - 1} onClick={() => onMove(1)} />
          <IconButton icon={Trash2} label="Aktion entfernen" size="sm" onClick={onRemove} />
        </div>
      </div>
    </div>
  );
}

function VersionsDialog({ open, onClose, ruleKey }: { open: boolean; onClose: () => void; ruleKey: ResultGroupKey }) {
  const qc = useQueryClient();
  const versions = useQuery({
    queryKey: ['admin', 'rules', ruleKey, 'versions'],
    queryFn: () => api.get<{ items: ResultGroupRuleVersion[] }>(`/api/admin/rules/${ruleKey}/versions`),
    enabled: open,
  });
  const restore = useMutation({
    mutationFn: (version: number) => api.post<ResultGroupRuleVersion>(`/api/admin/rules/${ruleKey}/restore`, { version }),
    onSuccess: (v) => {
      toast.success(`Als Version ${v.version} wiederhergestellt`);
      void qc.invalidateQueries({ queryKey: ['admin', 'rules'] });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Versionen" description="Alte Versionen bleiben erhalten. «Wiederherstellen» speichert die alte Fassung als neue Version.">
      {versions.isLoading ? (
        <SkeletonText lines={4} />
      ) : (
        <ul className="divide-y divide-border">
          {versions.data?.items.map((v) => (
            <li key={v.id} className="flex items-center justify-between gap-4 py-2.5 text-sm">
              <span>
                <span className="font-medium text-fg">Version {v.version}</span> · {v.label}
                <span className="ml-2 text-xs text-fg-subtle">
                  {formatDateTime(v.createdAt)} {v.createdByName ? `· ${v.createdByName}` : '· Standard'}
                </span>
              </span>
              {v.isActive ? (
                <Badge tone="success">aktiv</Badge>
              ) : (
                <Button size="sm" icon={RotateCcw} loading={restore.isPending && restore.variables === v.version} onClick={() => restore.mutate(v.version)}>
                  Wiederherstellen
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
