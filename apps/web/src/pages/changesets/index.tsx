/**
 * Ergebnis & Freigabe (INTENT 6.5, 6.8, 6.9): Ergebnisgruppe wählen → Eingaben → Vorschau alt → neu (Telefonaktivität,
 * Lead-Felder, Notiz, Aufgabe, neuer Lead, Status) → Konflikte pro Feld entscheiden → «Freigeben und speichern».
 * OWNER: coldcall implementer. `ResultPanel` is used by the workspace, `ChangeSetPreview` by the Pendenzen (Freigaben/Fehler).
 */
import {
  displayFieldValue,
  OPTION_SETS,
  optionLabel,
  followUpMailSent,
  followUpRequirement,
  formatZurich,
  RESULT_GROUP_LABELS,
  resultGroupShortcuts,
  type FollowUpRequirement,
  type ChangeSet,
  type Conflict,
  type Lead,
  type NewPersonInput,
  type ResultGroupKey,
  type ResultGroupRule,
  type ResultInput,
} from '@sales-portal/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CalendarPlus, CalendarRange, CheckCircle2, ListChecks, Mail, NotebookPen, Phone, RefreshCw, Sparkles, StickyNote, Trash2, UserPlus, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { api, errorMessage } from '@/app/api';
import { useAuth } from '@/app/auth';
import { useShortcut } from '@/app/shortcuts';
import { toast } from '@/app/toast';
import { Badge, Button, Card, Checkbox, cn, EmptyState, Input, Select, Skeleton, SkeletonText, Textarea } from '@/components/ui';
import { flushNote } from '@/pages/calls';

// ---------------------------------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------------------------------

interface DraftResponse {
  changeSet: ChangeSet | null;
  issues: { field: string; message: string }[];
}
interface PushResponse {
  status: ChangeSet['status'];
  changeSet: ChangeSet;
}

export const changeSetApi = {
  rules: () => api.get<{ items: ResultGroupRule[] }>('/api/changesets/rules'),
  get: (id: string) => api.get<ChangeSet>(`/api/changesets/${id}`),
  open: (leadId: string) => api.get<{ items: ChangeSet[] }>('/api/changesets', { status: ['draft', 'conflict', 'failed'], leadId }),
  /** Own change sets of the lead incl. pushed ones (sent proposals / use-case mails of this call). */
  ofLead: (leadId: string) => api.get<{ items: ChangeSet[] }>('/api/changesets', { status: ['draft', 'pending', 'conflict', 'pushed', 'failed'], leadId }),
  draft: (body: { leadId: string; callSessionId?: string | null; ruleKey: ResultGroupKey; input: ResultInput; changeSetId?: string | null }) =>
    api.post<DraftResponse>('/api/changesets', body),
  push: (id: string, resolutions: Record<string, 'overwrite' | 'keep_crm'> = {}) => api.post<PushResponse>(`/api/changesets/${id}/push`, { resolutions }),
  discard: (id: string) => api.post<{ changeSet: ChangeSet }>(`/api/changesets/${id}/discard`),
  revert: (id: string, reason?: string) => api.post<{ revert: ChangeSet; skipped: { label: string }[] }>(`/api/changesets/${id}/revert`, reason ? { reason } : {}),
};

export function useResultRules() {
  return useQuery({ queryKey: ['changesets', 'rules'], queryFn: changeSetApi.rules, staleTime: 5 * 60_000 });
}

/**
 * Undo a pushed change set (within 15 minutes for the caller). A call's result: the server reopens the call (its
 * phone call is cancelled in the CRM) – `openCall` brings the person back to the wrap-up to choose the result anew.
 */
export async function revertWithToast(cs: ChangeSet, after?: () => void, openCall?: () => void): Promise<void> {
  try {
    const res = await changeSetApi.revert(cs.id);
    const skipped = res.skipped.length ? `Nicht zurückgesetzt, weil inzwischen im CRM geändert: ${res.skipped.map((s) => s.label).join(', ')}` : null;
    if (cs.kind === 'call_result' && cs.callSessionId) {
      toast.info('Rückgängig gemacht – der Anruf ist wieder offen', {
        description: [skipped, 'Bitte das Ergebnis neu wählen und freigeben, sonst fehlt der Anruf im CRM.'].filter(Boolean).join(' '),
        action: openCall ? { label: 'Ergebnis neu wählen', onClick: openCall } : undefined,
        duration: 15_000,
      });
    } else {
      toast.info('Rückgängig gemacht', { description: skipped ?? undefined });
    }
    after?.();
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Preview (alt → neu)
// ---------------------------------------------------------------------------------------------------------------------

const fmt = (field: string, v: unknown) => displayFieldValue(field, v) ?? 'leer';
const dateTime = (iso: string | null | undefined) => (iso ? formatZurich(iso, 'EEEEEE dd.MM.yyyy HH:mm').replace(/^(\w\w)/, (d) => WEEKDAYS[d] ?? d) : '–');
const WEEKDAYS: Record<string, string> = { Mo: 'Mo', Tu: 'Di', We: 'Mi', Th: 'Do', Fr: 'Fr', Sa: 'Sa', Su: 'So' };

function Group({ icon: Icon, title, children, count }: { icon: typeof Phone; title: string; children: ReactNode; count?: number }) {
  return (
    <section className="border-t border-border py-3 first:border-t-0 first:pt-0">
      <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-fg-subtle uppercase">
        <Icon className="size-3.5" aria-hidden /> {title}
        {count != null && <span className="tabular rounded-full bg-surface-3 px-1.5 text-[10px] text-fg-muted">{count}</span>}
      </h4>
      {children}
    </section>
  );
}

export interface PreviewBodyProps {
  changeSet: ChangeSet;
  /** Decisions for conflicts (opId → choice). */
  resolutions?: Record<string, 'overwrite' | 'keep_crm'>;
  onResolve?: (opId: string, choice: 'overwrite' | 'keep_crm') => void;
}

/** All operations of a change set, grouped: Telefonaktivität · Lead-Felder · Notiz · Aufgabe · Neuer Lead · Status. */
export function PreviewBody({ changeSet: cs, resolutions = {}, onResolve }: PreviewBodyProps) {
  const failed = new Map(cs.results.filter((r) => !r.ok).map((r) => [r.opId, r.error ?? 'fehlgeschlagen']));
  const done = new Set(cs.results.filter((r) => r.ok).map((r) => r.opId));
  const conflictByOp = new Map(cs.conflicts.map((c) => [c.opId, c]));
  const mark = (id: string) =>
    failed.has(id) ? (
      <span className="ml-1 inline-flex items-center gap-1 text-xs text-danger" title={failed.get(id)}>
        <XCircle className="size-3.5" /> {failed.get(id)}
      </span>
    ) : done.has(id) ? (
      <CheckCircle2 className="ml-1 inline size-3.5 text-success" aria-label="gespeichert" />
    ) : null;

  return (
    <div className="text-sm">
      {cs.activities.length > 0 && (
        <Group icon={Phone} title="Telefonaktivität">
          {cs.activities.map((a) => (
            <div key={a.id} className="rounded-md bg-surface-2 px-3 py-2">
              <p className="font-medium text-fg">
                {a.subject}
                {mark(a.id)}
              </p>
              <p className="mt-0.5 text-xs text-fg-muted">
                {a.direction === 'incoming' ? 'eingehend' : 'ausgehend'} · {dateTime(a.start)}
                {a.durationSec != null && ` · ${Math.floor(a.durationSec / 60)}:${String(a.durationSec % 60).padStart(2, '0')} Min.`}
                {a.resultCode != null && ` · Ergebnis: ${optionLabel('kls_anrufergebnis', a.resultCode)}`}
                {a.interest != null && ` · Interesse: ${optionLabel('kls_interesse', a.interest)}`}
              </p>
              {a.action === 'create' && (
                <p className={cn('mt-1.5 line-clamp-4 text-[13px] whitespace-pre-wrap', a.text ? 'text-fg' : 'text-fg-subtle italic')}>{a.text ?? 'Noch keine Notiz – sie kommt als Text in den Anruf.'}</p>
              )}
            </div>
          ))}
        </Group>
      )}

      {cs.operations.length > 0 && (
        <Group icon={ListChecks} title="Lead-Felder" count={cs.operations.length}>
          <ul className="divide-y divide-border">
            {cs.operations.map((op) => {
              const c = conflictByOp.get(op.id);
              return (
                <li key={op.id} className="py-1.5">
                  <div className="grid grid-cols-[minmax(110px,0.8fr)_minmax(0,2fr)] items-baseline gap-3">
                    <span className="text-fg-muted">{op.label}</span>
                    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <span className="text-fg-subtle line-through decoration-fg-subtle/50">{op.oldDisplay ?? fmt(op.field, op.oldValue)}</span>
                      <ArrowRight className="size-3 shrink-0 self-center text-fg-subtle" aria-hidden />
                      <span className="font-medium text-fg">{op.newDisplay ?? fmt(op.field, op.newValue)}</span>
                      {op.mode === 'add_to_multiselect' && <span className="text-xs text-fg-subtle">(ergänzt)</span>}
                      {mark(op.id)}
                    </span>
                  </div>
                  {c && <ConflictRow conflict={c} field={op.field} choice={resolutions[c.opId] ?? c.resolution ?? null} onResolve={onResolve} />}
                </li>
              );
            })}
          </ul>
        </Group>
      )}

      {cs.notes.length > 0 && (
        <Group icon={StickyNote} title="Notiz">
          {cs.notes.map((n) => (
            <p key={n.id} className="rounded-md bg-surface-2 px-3 py-2 text-[13px] whitespace-pre-wrap text-fg">
              {n.text}
              {mark(n.id)}
            </p>
          ))}
        </Group>
      )}

      {cs.tasks.length > 0 && (
        <Group icon={NotebookPen} title="Aufgabe">
          {cs.tasks.map((t) => (
            <div key={t.id} className="mb-1.5 last:mb-0">
              <p className="text-fg">
                <Badge tone={t.action === 'cancel' ? 'neutral' : t.action === 'update' ? 'info' : 'primary'} className="mr-1.5">
                  {t.action === 'create' ? 'neu' : t.action === 'update' ? 'angepasst' : t.action === 'complete' ? 'erledigt' : 'geschlossen'}
                </Badge>
                {t.subject} · <span className="tabular">{dateTime(t.dueAt)}</span>
                {mark(t.id)}
              </p>
              {t.ruleNote && <p className="mt-0.5 text-xs text-fg-subtle">{t.ruleNote}</p>}
            </div>
          ))}
        </Group>
      )}

      {cs.leadCreates.length > 0 && (
        <Group icon={UserPlus} title="Neuer Lead (andere Ansprechperson)">
          {cs.leadCreates.map((l) => (
            <p key={l.id} className="text-fg">
              {[l.fields.firstname, l.fields.lastname].filter(Boolean).join(' ')}
              {l.fields.jobtitle && <span className="text-fg-muted"> · {l.fields.jobtitle}</span>}
              {l.fields.emailaddress1 && <span className="text-fg-muted"> · {l.fields.emailaddress1}</span>}
              {l.fields.telephone1 && <span className="tabular text-fg-muted"> · {l.fields.telephone1}</span>}
              {mark(l.id)}
            </p>
          ))}
        </Group>
      )}

      {cs.stateChanges.length > 0 && (
        <Group icon={AlertTriangle} title="Status (zuletzt, nach der Notiz)">
          {cs.stateChanges.map((s) => {
            const c = conflictByOp.get(s.id);
            return (
              <div key={s.id}>
                <p className="font-medium text-danger">
                  {s.label}
                  {mark(s.id)}
                </p>
                {c && <ConflictRow conflict={c} field={c.field} choice={resolutions[c.opId] ?? c.resolution ?? null} onResolve={onResolve} />}
              </div>
            );
          })}
        </Group>
      )}
    </div>
  );
}

function ConflictRow({ conflict: c, field, choice, onResolve }: { conflict: Conflict; field: string; choice: 'overwrite' | 'keep_crm' | null; onResolve?: (opId: string, choice: 'overwrite' | 'keep_crm') => void }) {
  return (
    <div className="mt-2 rounded-md border border-warning/40 bg-warning-subtle/60 p-2.5 text-[13px]">
      <p className="mb-1.5 flex items-center gap-1.5 font-medium text-warning">
        <AlertTriangle className="size-3.5" aria-hidden /> Seit dem Entwurf im CRM geändert
      </p>
      <dl className="grid grid-cols-3 gap-2">
        <div>
          <dt className="text-[11px] text-fg-subtle uppercase">Entwurf</dt>
          <dd className="text-fg-muted">{fmt(field, c.draftValue)}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-fg-subtle uppercase">CRM jetzt</dt>
          <dd className="font-medium text-fg">{fmt(field, c.crmNow)}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-fg-subtle uppercase">neu</dt>
          <dd className="font-medium text-fg">{fmt(field, c.newValue)}</dd>
        </div>
      </dl>
      {onResolve && (
        <div className="mt-2 flex gap-2" role="radiogroup" aria-label={`Entscheid für ${c.label}`}>
          <Button size="sm" variant={choice === 'keep_crm' ? 'primary' : 'secondary'} role="radio" aria-checked={choice === 'keep_crm'} onClick={() => onResolve(c.opId, 'keep_crm')}>
            CRM-Wert behalten
          </Button>
          <Button size="sm" variant={choice === 'overwrite' ? 'primary' : 'secondary'} role="radio" aria-checked={choice === 'overwrite'} onClick={() => onResolve(c.opId, 'overwrite')}>
            Überschreiben
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Wrap-up inputs
// ---------------------------------------------------------------------------------------------------------------------

/** `YYYY-MM-DDTHH:mm` (local) for <input type="datetime-local">. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function at(daysFromNow: number, hour: number, minute = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, minute, 0, 0);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString();
}
function inMonths(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  d.setHours(9, 0, 0, 0);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

function dateChips(): { label: string; value: string }[] {
  const now = new Date();
  const chips: { label: string; value: string }[] = [];
  if (now.getHours() < 15 && now.getDay() !== 0 && now.getDay() !== 6) chips.push({ label: 'Heute 16:00', value: at(0, 16) });
  chips.push({ label: 'Morgen 10:00', value: at(1, 10) }, { label: 'Morgen 14:00', value: at(1, 14) }, { label: 'In 1 Woche', value: at(7, 10) });
  chips.push({ label: 'In 1 Monat', value: inMonths(1) }, { label: 'In 3 Monaten', value: inMonths(3) }, { label: 'In 6 Monaten', value: inMonths(6) });
  return chips;
}

const issueFor = (issues: DraftResponse['issues'], field: string) => issues.find((i) => i.field === field || i.field.startsWith(`${field}.`))?.message;

function InputsForm({
  rule,
  input,
  onChange,
  issues,
  showNewPerson,
  onToggleNewPerson,
}: {
  rule: ResultGroupRule;
  input: ResultInput;
  onChange: (next: ResultInput) => void;
  issues: DraftResponse['issues'];
  showNewPerson: boolean;
  onToggleNewPerson: (open: boolean) => void;
}) {
  const inputs = new Set(rule.inputs ?? []);
  const set = <K extends keyof ResultInput>(k: K, v: ResultInput[K]) => onChange({ ...input, [k]: v });
  const disqualifies = rule.fieldActions.some((a) => a.kind === 'disqualify');
  const personAllowed = rule.isRealContact;
  const person: NewPersonInput = input.newPerson ?? { firstname: '', lastname: '', samePerson: false };
  const setPerson = (patch: Partial<NewPersonInput>) => set('newPerson', { ...person, ...patch });

  return (
    <div className="space-y-4">
      {(inputs.has('followUpAt') || rule.callStatus.mode === 'by_date') && (
        <div>
          <Input
            label={rule.key === 'callback' ? 'Rückruf am' : 'Wieder melden am'}
            type="datetime-local"
            value={toLocalInput(input.followUpAt)}
            onChange={(e) => set('followUpAt', e.target.value ? new Date(e.target.value).toISOString() : null)}
            error={issueFor(issues, 'followUpAt')}
            hint="Bestimmt den Anrufstatus (heute, morgen, diese Woche …) und die Aufgabe."
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {dateChips().map((c) => (
              <button
                key={c.label}
                type="button"
                onClick={() => set('followUpAt', c.value)}
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                  input.followUpAt && Math.abs(Date.parse(input.followUpAt) - Date.parse(c.value)) < 60_000 ? 'border-primary bg-primary-subtle text-primary' : 'border-border-strong text-fg-muted hover:text-fg',
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {inputs.has('interest') && (
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-fg">Interesse</p>
          <div className="grid grid-cols-4 gap-1 rounded-lg bg-surface-2 p-1" role="radiogroup" aria-label="Interesse">
            {OPTION_SETS.kls_interesse.map((o) => (
              <button
                key={o.code}
                type="button"
                role="radio"
                aria-checked={input.interest === o.code}
                title={`${o.code} · ${o.label}`}
                onClick={() => set('interest', input.interest === o.code ? null : o.code)}
                className={cn(
                  'h-8 min-w-0 truncate rounded-md px-1.5 text-[13px] font-medium',
                  input.interest === o.code ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg',
                )}
              >
                {o.code} {INTEREST_SHORT[o.code] ?? o.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-fg-subtle">Ab «offen» wird die Bewertung «Potenzial vorhanden» gesetzt.</p>
        </div>
      )}
      {inputs.has('employees') && (
        <Input
          label="Genannte Zahl Mitarbeitende"
          type="number"
          min={1}
          className="w-56"
          value={input.employees ?? ''}
          onChange={(e) => set('employees', e.target.value === '' ? null : Number(e.target.value))}
          error={issueFor(issues, 'employees')}
          hint="Unter 5: disqualifiziert (Ausserhalb ICP). Ab 5: nur Bewertung, Lead bleibt offen."
        />
      )}
      {inputs.has('correctedPhone') && (
        <div className="flex flex-wrap items-end gap-2">
          <Input
            label="Richtige Nummer (falls bekannt)"
            placeholder="z. B. 061 123 45 67"
            className="w-60"
            value={input.correctedPhone ?? ''}
            onChange={(e) => set('correctedPhone', e.target.value || null)}
            error={issueFor(issues, 'correctedPhone')}
            hint="Wird im einheitlichen Format (+41 …) gespeichert."
          />
          <Select
            aria-label="Feld"
            className="w-40"
            value={input.correctedPhoneField ?? 'telephone1'}
            onChange={(e) => set('correctedPhoneField', e.target.value as 'telephone1' | 'mobilephone')}
            options={[
              { value: 'telephone1', label: 'Telefon' },
              { value: 'mobilephone', label: 'Mobile' },
            ]}
          />
        </div>
      )}
      {inputs.has('decisionMakerInMeeting') && (
        <Checkbox label="Entscheider ist im Termin dabei" checked={input.decisionMakerInMeeting === true} onChange={(e) => set('decisionMakerInMeeting', e.target.checked || null)} />
      )}
      {inputs.has('budgetMentioned') && <Checkbox label="Budget wurde genannt" checked={input.budgetMentioned === true} onChange={(e) => set('budgetMentioned', e.target.checked || null)} />}
      {(inputs.has('reason') || disqualifies) && (
        <Textarea
          label={disqualifies ? 'Grund aus dem Gespräch (Beleg)' : 'Grund (optional)'}
          rows={2}
          maxLength={2000}
          value={input.reason ?? ''}
          onChange={(e) => set('reason', e.target.value || null)}
          error={issueFor(issues, 'reason')}
          hint={disqualifies ? 'Steht in der Notiz «Sales-Portal: Nicht qualifiziert – …», bevor der Lead geschlossen wird.' : undefined}
        />
      )}
      {personAllowed && (
        <div className="rounded-md border border-border p-3">
          <Checkbox
            label={inputs.has('newPerson') && rule.key === 'wrong_person' ? 'Neue Ansprechperson bekannt' : 'Andere Ansprechperson erfassen'}
            description="Gleiche Person mit neuer Adresse → Lead wird aktualisiert. Andere Person → neuer Lead derselben Firma (max. 2 pro Firma)."
            checked={showNewPerson}
            onChange={(e) => {
              onToggleNewPerson(e.target.checked);
              if (!e.target.checked) set('newPerson', null);
            }}
          />
          {showNewPerson && (
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              <Select
                aria-label="Art"
                className="col-span-2"
                value={person.samePerson ? 'same' : 'other'}
                onChange={(e) => setPerson({ samePerson: e.target.value === 'same' })}
                options={[
                  { value: 'other', label: 'Andere Person (neuer Lead)' },
                  { value: 'same', label: 'Gleiche Person, neue Angaben' },
                ]}
              />
              <Select
                aria-label="Anrede"
                value={person.salutation != null ? String(person.salutation) : ''}
                onChange={(e) => setPerson({ salutation: e.target.value ? Number(e.target.value) : null })}
                options={[{ value: '', label: 'Anrede offen lassen' }, ...OPTION_SETS.kls_salutation.map((o) => ({ value: String(o.code), label: o.label }))]}
              />
              <Input aria-label="Funktion" placeholder="Funktion" value={person.jobtitle ?? ''} onChange={(e) => setPerson({ jobtitle: e.target.value || null })} />
              <Input aria-label="Vorname" placeholder="Vorname" value={person.firstname} onChange={(e) => setPerson({ firstname: e.target.value })} />
              <Input aria-label="Nachname" placeholder="Nachname" value={person.lastname} onChange={(e) => setPerson({ lastname: e.target.value })} error={issueFor(issues, 'newPerson.lastname')} />
              <Input aria-label="E-Mail" placeholder="E-Mail" type="email" value={person.email ?? ''} onChange={(e) => setPerson({ email: e.target.value || null })} error={issueFor(issues, 'newPerson.email')} />
              <Input aria-label="Telefon" placeholder="Telefon" value={person.phone ?? ''} onChange={(e) => setPerson({ phone: e.target.value || null })} error={issueFor(issues, 'newPerson.phone')} />
              {issues.find((i) => i.field === 'newPerson') && <p className="col-span-2 text-xs text-danger">{issues.find((i) => i.field === 'newPerson')!.message}</p>}
              <p className="col-span-2 text-xs text-fg-subtle">Anrede nur setzen, wenn sicher (90-%-Regel).</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// ResultPanel
// ---------------------------------------------------------------------------------------------------------------------

/** Short labels so the four choices fit the right column (full text as tooltip). */
const INTEREST_SHORT: Record<number, string> = { 0: 'kein', 1: 'schwach', 2: 'offen', 3: 'klar' };


const GROUPS: { title: string; keys: ResultGroupKey[] }[] = [
  { title: 'Weiter im Gespräch', keys: ['meeting_booked', 'proposals_sent', 'info_mail', 'callback', 'waiting', 'later'] },
  { title: 'Kein Interesse', keys: ['no_need', 'has_partner', 'internal_group', 'too_small', 'do_not_contact', 'competitor'] },
  { title: 'Sonstiges', keys: ['wrong_person', 'wrong_number', 'not_reached'] },
];

export interface ResultPanelProps {
  leadId: string;
  callSessionId?: string | null;
  /** Preselect a group (quick buttons «Rückruf», «Termin» …). */
  initialRule?: ResultGroupKey | null;
  /** Open the «andere Ansprechperson» form right away (quick button «andere Person»). */
  initialNewPerson?: boolean;
  /** Lead (for prefilled values such as the number of employees). */
  lead?: Lead | null;
  /** Called after a successful push. */
  onPushed?: (changeSet: ChangeSet) => void;
  /** Hint above the panel (e.g. «Gespräch läuft noch»). */
  hint?: ReactNode;
  /** Start of the call: mails / proposals sent since then count for «3 Vorschläge gesendet» / «Mail mit Infos». */
  callStartedAt?: string | null;
  /** Switch the workspace's right panel (Terminplaner, 3 Vorschläge, Mail). */
  onOpenTab?: (tab: 'scheduling' | 'proposals' | 'mail') => void;
}


export function ResultPanel({ leadId, callSessionId = null, initialRule = null, initialNewPerson = false, lead, onPushed, hint, callStartedAt = null, onOpenTab }: ResultPanelProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const rules = useResultRules();
  const [ruleKey, setRuleKey] = useState<ResultGroupKey | null>(initialRule);
  const [input, setInput] = useState<ResultInput>({});
  const [showNewPerson, setShowNewPerson] = useState(initialNewPerson);
  const [cs, setCs] = useState<ChangeSet | null>(null);
  const [issues, setIssues] = useState<DraftResponse['issues']>([]);
  const [building, setBuilding] = useState(false);
  const [resolutions, setResolutions] = useState<Record<string, 'overwrite' | 'keep_crm'>>({});
  const seq = useRef(0);
  const csRef = useRef<ChangeSet | null>(null);
  csRef.current = cs;

  useEffect(() => {
    if (initialRule) setRuleKey(initialRule);
  }, [initialRule]);
  useEffect(() => {
    if (initialNewPerson) setShowNewPerson(true);
  }, [initialNewPerson]);

  // Restore an open draft of this call after a reload («nichts geht verloren»).
  const open = useQuery({ queryKey: ['changesets', 'open', leadId], queryFn: () => changeSetApi.open(leadId), staleTime: 0 });
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !open.data) return;
    restored.current = true;
    const existing = open.data.items.find((c) => (c.callSessionId ?? null) === callSessionId && (c.kind === 'call_result' || c.kind === 'not_reached'));
    if (!existing) return;
    setCs(existing);
    if (!initialRule && existing.ruleKey) setRuleKey(existing.ruleKey);
    const saved = existing.baseSnapshot['meta:input'] as ResultInput | undefined;
    if (saved) {
      setInput(saved);
      if (saved.newPerson) setShowNewPerson(true);
    }
  }, [open.data, callSessionId, initialRule]);

  const rule = rules.data?.items.find((r) => r.key === ruleKey) ?? null;
  const locked = !!cs && cs.results.some((r) => r.ok) && cs.status === 'failed';

  // Rebuild the draft (debounced) whenever group or inputs change.
  useEffect(() => {
    if (!ruleKey || locked) return;
    const mine = ++seq.current;
    setBuilding(true);
    const id = window.setTimeout(async () => {
      try {
        const res = await changeSetApi.draft({ leadId, callSessionId, ruleKey, input, changeSetId: csRef.current && csRef.current.status !== 'pushed' ? csRef.current.id : null });
        if (mine !== seq.current) return;
        setIssues(res.issues);
        if (res.changeSet) setCs(res.changeSet);
        if (!res.issues.length) setResolutions({});
      } catch (err) {
        if (mine === seq.current) toast.error(errorMessage(err));
      } finally {
        if (mine === seq.current) setBuilding(false);
      }
    }, 350);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleKey, JSON.stringify(input), leadId, callSessionId, locked]);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['workspace', leadId] });
    void queryClient.invalidateQueries({ queryKey: ['leads'] });
    void queryClient.invalidateQueries({ queryKey: ['changesets', 'open', leadId] });
    void queryClient.invalidateQueries({ queryKey: ['calls'] });
    void queryClient.invalidateQueries({ queryKey: ['me', 'counters'] });
  }, [leadId, queryClient]);

  const push = useMutation({
    mutationFn: async () => {
      if (!cs) throw new Error('Kein Entwurf');
      // A note that did not reach the server stops the push (else the phone call would get an older text).
      if (callSessionId) await flushNote(callSessionId);
      return changeSetApi.push(cs.id, resolutions);
    },
    onSuccess: (res) => {
      setCs(res.changeSet);
      if (res.status === 'pushed') {
        const label = rule?.label ?? 'Ergebnis';
        const reopen = res.changeSet.callSessionId ? () => navigate(`/lead/${leadId}?anruf=${res.changeSet.callSessionId}`) : undefined;
        toast.success(`Gespeichert: ${label}`, {
          description: 'Telefonaktivität und Felder sind im CRM.',
          action: { label: 'Rückgängig', onClick: () => void revertWithToast(res.changeSet, invalidate, reopen) },
        });
        invalidate();
        onPushed?.(res.changeSet);
      } else if (res.status === 'conflict') {
        toast.warning('Im CRM wurde inzwischen etwas geändert', { description: 'Bitte pro Feld entscheiden, dann nochmals freigeben.' });
      } else {
        toast.error('Nicht alles wurde gespeichert', { description: 'Der Entwurf bleibt im Portal – «Erneut versuchen».' });
        invalidate();
      }
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const discard = useMutation({
    mutationFn: () => changeSetApi.discard(cs!.id),
    onSuccess: () => {
      setCs(null);
      setRuleKey(null);
      setInput({});
      setIssues([]);
      invalidate();
      toast.info('Entwurf verworfen');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  // «3 Vorschläge gesendet» / «Mail mit Infos» without the mail: say so, offer the panel, approve only on purpose.
  const need = followUpRequirement(rule);
  const leadSets = useQuery({ queryKey: ['changesets', 'lead', leadId], queryFn: () => changeSetApi.ofLead(leadId), enabled: need === 'proposals' || need === 'mail', staleTime: 0 });
  const [confirmedWithout, setConfirmedWithout] = useState<FollowUpRequirement>(null);
  const mailMissing = (need === 'proposals' || need === 'mail') && !!leadSets.data && !followUpMailSent(leadSets.data.items, need, callStartedAt);
  const gateOpen = !mailMissing || confirmedWithout === need;

  const unresolved = (cs?.conflicts ?? []).filter((c) => !(resolutions[c.opId] ?? c.resolution)).length;
  const canPush = !!cs && !building && issues.length === 0 && unresolved === 0 && cs.status !== 'pushed' && !push.isPending && gateOpen;
  // One push per click: key repeat and a second press before the re-render are ignored (the server refuses it too).
  const pushing = useRef(false);
  const doPush = () => {
    if (pushing.current) return;
    pushing.current = true;
    push.mutate(undefined, { onSettled: () => (pushing.current = false) });
  };
  useShortcut('mod+enter', (e) => !e.repeat && canPush && doPush(), { description: 'Freigeben und speichern', group: 'Ergebnis', allowInInput: true });

  const byKey = useMemo(() => new Map((rules.data?.items ?? []).map((r) => [r.key, r])), [rules.data]);
  const shortcuts = useMemo(() => resultGroupShortcuts(rules.data?.items ?? []), [rules.data]);
  const pick = (key: ResultGroupKey) => {
    if (cs?.status === 'pushed') return;
    setRuleKey(key);
    if (key === 'too_small' && input.employees == null && lead?.numberofemployees != null && lead.numberofemployees < 5) setInput((i) => ({ ...i, employees: lead.numberofemployees }));
  };

  if (rules.isLoading) return <SkeletonText lines={6} />;
  if (!rules.data?.items.length) return <EmptyState compact title="Keine Ergebnisgruppen aktiv" description="Der Admin pflegt die Ergebnisgruppen." />;

  if (cs?.status === 'pushed') {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-success/30 bg-success-subtle px-4 py-3 text-sm text-success">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div>
            <p className="font-semibold">Gespeichert: {rule?.label}</p>
            <p className="text-[13px]">Alles ist im CRM und im Protokoll. Die KI-Analyse folgt später.</p>
          </div>
        </div>
        <PreviewBody changeSet={cs} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {hint}
      <div className="space-y-3">
        {GROUPS.map((g) => {
          const items = g.keys.map((k) => byKey.get(k)).filter((r): r is ResultGroupRule => !!r);
          if (!items.length) return null;
          return (
            <div key={g.title}>
              <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">{g.title}</p>
              <div className="grid grid-cols-2 gap-1.5">
                {items.map((r) => (
                  <RuleButton key={r.key} rule={r} shortcut={shortcuts.get(r.key)} active={r.key === ruleKey} onPick={pick} />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {rule && (
        <Card className="p-4">
          {rule.description && <p className="mb-3 text-xs text-fg-muted">{rule.description}</p>}
          {locked ? (
            <p className="text-sm text-fg-muted">Ein Teil ist schon gespeichert – Eingaben sind gesperrt. «Erneut versuchen» speichert den Rest.</p>
          ) : (
            <InputsForm rule={rule} input={input} onChange={setInput} issues={issues} showNewPerson={showNewPerson} onToggleNewPerson={setShowNewPerson} />
          )}
          {rule.followUp.hint && <p className="mt-3 text-xs text-fg-subtle">Folgeaktion: {rule.followUp.hint}</p>}
        </Card>
      )}

      {need === 'booking' && issues.some((i) => i.field === 'booking') && (
        <FollowUpHint
          icon={CalendarPlus}
          text="Noch kein Termin gebucht. «Termin gebucht» kommt mit der Buchung – zuerst im Terminplaner buchen, dann hier freigeben."
          actionLabel="Zum Terminplaner"
          onAction={onOpenTab ? () => onOpenTab('scheduling') : undefined}
        />
      )}
      {mailMissing && (
        <FollowUpHint
          icon={need === 'proposals' ? CalendarRange : Mail}
          text={need === 'proposals' ? 'Noch keine 3 Vorschläge gesendet.' : 'Noch keine Use-Case-Mail gesendet.'}
          actionLabel={need === 'proposals' ? '3 Vorschläge' : 'Mail vorbereiten'}
          onAction={onOpenTab ? () => onOpenTab(need === 'proposals' ? 'proposals' : 'mail') : undefined}
        >
          <Checkbox
            label="Trotzdem freigeben"
            description={need === 'proposals' ? 'Die Vorschläge gehen anders raus (z. B. aus Outlook).' : 'Die Mail geht anders raus (z. B. aus Outlook).'}
            checked={confirmedWithout === need}
            onChange={(e) => setConfirmedWithout(e.target.checked ? need : null)}
          />
        </FollowUpHint>
      )}

      {rule && (
        <section aria-label="Vorschau der CRM-Änderungen">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[13px] font-semibold text-fg">Vorschau alt → neu</h3>
            {building && <span className="text-xs text-fg-subtle">wird berechnet …</span>}
          </div>
          {!cs ? (
            issues.length ? (
              <p className="rounded-md bg-surface-2 px-3 py-2 text-[13px] text-fg-muted">
                {issues.every((i) => i.field === 'booking') ? 'Die Vorschau erscheint, sobald der Termin gebucht ist.' : 'Bitte die markierten Angaben ergänzen – dann erscheint die Vorschau.'}
              </p>
            ) : (
              <div className="space-y-2">
                <Skeleton className="h-14" />
                <Skeleton className="h-24" />
              </div>
            )
          ) : (
            <div className={cn('rounded-lg border border-border p-3.5', building && 'opacity-60')}>
              <PreviewBody changeSet={cs} resolutions={resolutions} onResolve={(opId, choice) => setResolutions((r) => ({ ...r, [opId]: choice }))} />
            </div>
          )}
        </section>
      )}

      {cs?.status === 'failed' && cs.error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-[13px] text-danger">
          <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> {cs.error}
        </div>
      )}

      {rule && (
        <div className="sticky bottom-0 -mx-1 flex items-center gap-2 bg-surface px-1 pt-2 pb-1">
          <Button
            variant="primary"
            size="lg"
            className="flex-1"
            icon={cs?.status === 'failed' ? RefreshCw : CheckCircle2}
            kbd="Ctrl ↵"
            disabled={!canPush}
            loading={push.isPending}
            onClick={doPush}
          >
            {cs?.status === 'failed' ? 'Erneut versuchen' : unresolved ? `${unresolved} Konflikt${unresolved > 1 ? 'e' : ''} entscheiden` : 'Freigeben und speichern'}
          </Button>
          {cs && !locked && (
            <Button variant="ghost" icon={Trash2} disabled={discard.isPending} onClick={() => discard.mutate()} title="Entwurf verwerfen">
              Verwerfen
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function FollowUpHint({ icon: Icon, text, actionLabel, onAction, children }: { icon: typeof Mail; text: string; actionLabel: string; onAction?: () => void; children?: ReactNode }) {
  return (
    <div role="status" className="space-y-2 rounded-md border border-warning/40 bg-warning-subtle/60 px-3 py-2.5 text-[13px] text-fg">
      <p className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        <span className="flex-1">{text}</span>
        {onAction && (
          <Button size="sm" variant="secondary" onClick={onAction}>
            {actionLabel}
          </Button>
        )}
      </p>
      {children}
    </div>
  );
}

function RuleButton({ rule, shortcut: key, active, onPick }: { rule: ResultGroupRule; shortcut?: string; active: boolean; onPick: (key: ResultGroupKey) => void }) {
  useShortcut(key ?? `__none_${rule.key}`, () => onPick(rule.key), { description: rule.label, group: 'Ergebnis', enabled: !!key, hidden: !key });
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onPick(rule.key)}
      className={cn(
        'flex min-h-9 items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-[13px] transition-colors',
        active ? 'border-primary bg-primary-subtle font-medium text-primary' : 'border-border-strong bg-surface text-fg hover:bg-surface-2',
      )}
    >
      <span className="line-clamp-2">{rule.label}</span>
      {key && <kbd className="rounded bg-surface-3 px-1 font-sans text-[10px] text-fg-muted uppercase">{key}</kbd>}
    </button>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// ChangeSetPreview (Pendenzen «Freigaben» / «Fehler»)
// ---------------------------------------------------------------------------------------------------------------------

export interface ChangeSetPreviewProps {
  changeSetId: string;
  /** Called after push / discard. */
  onDone?: (changeSet: ChangeSet) => void;
}

/** Preview of one stored change set (alt → neu, conflicts) with «Freigeben» / «Erneut versuchen» / «Verwerfen». */
export function ChangeSetPreview({ changeSetId, onDone }: ChangeSetPreviewProps) {
  const queryClient = useQueryClient();
  const { hasRole } = useAuth();
  const q = useQuery({ queryKey: ['changesets', changeSetId], queryFn: () => changeSetApi.get(changeSetId) });
  const pushing = useRef(false);
  const [resolutions, setResolutions] = useState<Record<string, 'overwrite' | 'keep_crm'>>({});
  const refresh = (cs: ChangeSet) => {
    queryClient.setQueryData(['changesets', changeSetId], cs);
    void queryClient.invalidateQueries({ queryKey: ['me', 'counters'] });
  };
  const push = useMutation({
    mutationFn: async () => {
      if (q.data?.callSessionId) await flushNote(q.data.callSessionId);
      return changeSetApi.push(changeSetId, resolutions);
    },
    onSuccess: (res) => {
      refresh(res.changeSet);
      if (res.status === 'pushed') {
        toast.success('Gespeichert', { action: { label: 'Rückgängig', onClick: () => void revertWithToast(res.changeSet, () => void q.refetch()) } });
        onDone?.(res.changeSet);
      } else if (res.status === 'conflict') toast.warning('Bitte Konflikte entscheiden');
      else toast.error('Nicht alles wurde gespeichert – bitte erneut versuchen');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const discard = useMutation({
    mutationFn: () => changeSetApi.discard(changeSetId),
    onSuccess: (res) => {
      refresh(res.changeSet);
      onDone?.(res.changeSet);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (q.isLoading) return <SkeletonText lines={5} />;
  if (!q.data) return <EmptyState compact title="Entwurf nicht gefunden" />;
  const cs = q.data;
  const unresolved = cs.conflicts.filter((c) => !(resolutions[c.opId] ?? c.resolution)).length;
  // AI analyses have their own approval (tick single proposals) – never «approve all» here.
  const ownFlow = cs.kind === 'analysis';
  const openStatus = (cs.status === 'draft' || cs.status === 'conflict' || cs.status === 'failed') && !ownFlow;
  const doPush = () => {
    if (pushing.current) return;
    pushing.current = true;
    push.mutate(undefined, { onSettled: () => (pushing.current = false) });
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <Badge tone={cs.status === 'failed' ? 'danger' : cs.status === 'conflict' ? 'warning' : cs.status === 'pushed' ? 'success' : 'neutral'}>
          {{ draft: 'Entwurf', pending: 'wird gespeichert', conflict: 'Konflikt', pushed: 'gespeichert', failed: 'fehlgeschlagen', discarded: 'verworfen' }[cs.status]}
        </Badge>
        {cs.ruleKey && <span>{RESULT_GROUP_LABELS[cs.ruleKey] ?? 'Ergebnis'}</span>}
        {cs.ruleKey && hasRole('admin') && (
          <span className="text-fg-subtle">
            ({cs.ruleKey} · Version {cs.ruleVersion})
          </span>
        )}
        <span>erstellt {dateTime(cs.createdAt)}</span>
      </div>
      {cs.error && <p className="text-[13px] text-danger">{cs.error}</p>}
      {ownFlow && (cs.status === 'draft' || cs.status === 'failed') && (
        <p className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-[13px] text-fg-muted">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          KI-Vorschläge werden unter «Analysen zur Freigabe» einzeln angekreuzt und dort ergänzt – hier nur zur Ansicht.
        </p>
      )}
      <PreviewBody changeSet={cs} resolutions={resolutions} onResolve={(opId, choice) => setResolutions((r) => ({ ...r, [opId]: choice }))} />
      {openStatus && (
        <div className="flex gap-2 border-t border-border pt-3">
          <Button variant="primary" loading={push.isPending} disabled={unresolved > 0} onClick={doPush}>
            {cs.status === 'failed' ? 'Erneut versuchen' : unresolved ? 'Konflikte entscheiden' : 'Freigeben und speichern'}
          </Button>
          {!cs.results.some((r) => r.ok) && (
            <Button variant="ghost" icon={Trash2} disabled={discard.isPending} onClick={() => discard.mutate()}>
              Verwerfen
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export default ResultPanel;
