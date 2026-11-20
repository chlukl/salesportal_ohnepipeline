/**
 * «Analysen zur Freigabe» (INTENT 6.4): KI-Zusammenfassung + Interesse pro Anruf; ein Klick «Ergänzen» schreibt beides
 * in die Telefonaktivität. Weitere Vorschläge der KI (andere Ergebnisgruppe, Entscheider, Felder, neue Ansprechperson)
 * erscheinen als alt → neu und gehen nur mit, wenn Markus sie ankreuzt. Alles KI-Material wird als Text angezeigt.
 */
import { formatZurich, useCaseLabel, type CallAnalysis, type Conflict, type FieldOp, type Objection } from '@sales-portal/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, ChevronDown, ChevronUp, Quote, Sparkles, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '@/app/api';
import { useShortcut } from '@/app/shortcuts';
import { toast } from '@/app/toast';
import { Badge, Button, Card, Checkbox, cn, EmptyState, Skeleton, SkeletonText, type BadgeTone } from '@/components/ui';
import { ChangeSetPreview } from '@/pages/changesets';
import type { AnalysisReviewItem, ApproveResponse } from './types';

export const REVIEW_QUERY_KEY = ['ai', 'review'] as const;

const INTEREST: Record<number, { label: string; tone: BadgeTone }> = {
  0: { label: 'Kein Interesse', tone: 'neutral' },
  1: { label: 'Interesse schwach', tone: 'warning' },
  2: { label: 'Interesse offen', tone: 'info' },
  3: { label: 'Interesse klar', tone: 'success' },
};

const OBJECTIONS: Record<Objection, string> = {
  partner: 'hat Partner',
  internal_group: 'intern / Konzern',
  too_small: 'zu klein',
  no_budget: 'kein Budget',
  bad_timing: 'falscher Zeitpunkt',
  no_interest: 'kein Interesse',
};

function duration(sec: number | null): string | null {
  if (!sec) return null;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} Min.`;
}

function valueText(v: unknown, display?: string | null): string {
  if (display) return display;
  if (v == null || v === '') return 'leer';
  if (typeof v === 'boolean') return v ? 'Ja' : 'Nein';
  return String(v);
}

export interface AnalysisReviewListProps {
  /** Admin: show the analyses of another user. */
  userId?: string;
  /** Smaller header (inside Pendenzen). */
  compact?: boolean;
  /** Only analyses of this lead (workspace). */
  leadId?: string;
  /** Only this analysis (deep link `?analyse=<id>` from the Pendenzen). */
  analysisId?: string;
}

export function AnalysisReviewList({ userId, compact, leadId, analysisId }: AnalysisReviewListProps = {}) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: [...REVIEW_QUERY_KEY, userId ?? 'me'],
    queryFn: () => api.get<{ items: AnalysisReviewItem[] }>('/api/ai/analyses/review', { userId }),
  });
  const items = (data?.items ?? []).filter((i) => (!leadId || i.analysis.leadId === leadId) && (!analysisId || i.analysis.id === analysisId));
  const [selected, setSelected] = useState(0);
  const current = items[Math.min(selected, Math.max(0, items.length - 1))];

  useShortcut('j', () => setSelected((i) => Math.min(i + 1, items.length - 1)), { description: 'Nächste Analyse', group: 'Analysen', enabled: items.length > 1 });
  useShortcut('k', () => setSelected((i) => Math.max(i - 1, 0)), { description: 'Vorherige Analyse', group: 'Analysen', enabled: items.length > 1 });

  if (isLoading) {
    return (
      <div className="space-y-3" aria-busy>
        {[0, 1].map((i) => (
          <Card key={i} className="p-5">
            <Skeleton className="mb-3 h-4 w-1/3" />
            <SkeletonText lines={3} />
          </Card>
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <Card>
        <EmptyState
          compact
          icon={TriangleAlert}
          title="Analysen konnten nicht geladen werden"
          description="Bitte nochmals versuchen."
          action={<Button onClick={() => void refetch()}>Erneut laden</Button>}
        />
      </Card>
    );
  }
  if (!items.length) {
    return (
      <Card>
        <EmptyState
          compact={compact}
          icon={Sparkles}
          title="Keine Analysen zur Freigabe"
          description="Sobald Vera ein Gespräch transkribiert hat, erscheint hier die KI-Zusammenfassung. Ein Klick ergänzt dann den Anruf im CRM."
        />
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      {!compact && (
        <p className="text-sm text-fg-muted">
          {items.length === 1 ? '1 Analyse wartet' : `${items.length} Analysen warten`} auf deine Freigabe. Die KI schlägt nur vor – ins CRM geht nur, was du ergänzt.
        </p>
      )}
      {items.map((item, i) => (
        <AnalysisCard key={item.analysis.id} item={item} active={item === current} onFocus={() => setSelected(i)} />
      ))}
    </div>
  );
}

function AnalysisCard({ item, active, onFocus }: { item: AnalysisReviewItem; active: boolean; onFocus: () => void }) {
  const queryClient = useQueryClient();
  const { analysis, call, changeSet } = item;
  const result = analysis.result as CallAnalysis | null;
  const proposals: FieldOp[] = changeSet?.operations ?? [];
  const newContact = changeSet?.leadCreates?.[0] ?? null;
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [acceptContact, setAcceptContact] = useState(false);
  const [applyPreparation, setApplyPreparation] = useState(false);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [resolutions, setResolutions] = useState<Record<string, 'overwrite' | 'keep_crm'>>({});
  const [showDetails, setShowDetails] = useState(false);

  const done = () => {
    void queryClient.invalidateQueries({ queryKey: REVIEW_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ['me', 'counters'] });
    void queryClient.invalidateQueries({ queryKey: ['pendenzen'] });
  };

  const approve = useMutation({
    mutationFn: () =>
      api.post<ApproveResponse>(`/api/ai/analyses/${analysis.id}/approve`, {
        acceptOpIds: [...accepted],
        acceptLeadCreate: acceptContact,
        resolutions,
        applyPreparation,
      }),
    onSuccess: (res) => {
      if (res.status === 'conflict') {
        setConflicts(res.conflicts);
        toast.warning('Im CRM wurde inzwischen etwas geändert', { description: 'Bitte pro Feld entscheiden, dann nochmals ergänzen.' });
        return;
      }
      toast.success('Anruf ergänzt', { description: `${call?.companyName ?? 'Lead'}: Zusammenfassung und Interesse sind im CRM.` });
      done();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const submit = () => {
    if (!approve.isPending) approve.mutate();
  };

  const dismiss = useMutation({
    mutationFn: () => api.post(`/api/ai/analyses/${analysis.id}/dismiss`),
    onSuccess: () => {
      toast.info('Analyse verworfen', { description: 'Der Anruf bleibt mit deiner Notiz im CRM.' });
      done();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const canApprove = analysis.status === 'ready' && !!call?.pushed && conflicts.every((c) => resolutions[c.opId]);
  useShortcut('e', () => submit(), { description: 'Analyse ergänzen', group: 'Analysen', enabled: active && canApprove && !approve.isPending });
  useShortcut('x', () => dismiss.mutate(), { description: 'Analyse verwerfen', group: 'Analysen', enabled: active && !dismiss.isPending });

  const toggle = (id: string) =>
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const when = call?.endedAt ? formatZurich(call.endedAt, 'dd.MM. HH:mm') : null;
  const interest = result ? INTEREST[result.interest.level] : null;

  return (
    <Card
      className={cn('overflow-hidden transition-shadow', active && 'ring-2 ring-ring')}
      onMouseEnter={onFocus}
      onFocusCapture={onFocus}
      aria-label={`Analyse ${call?.companyName ?? ''}`}
    >
      <header className="flex items-start justify-between gap-4 px-5 pt-4">
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold text-fg">{call?.companyName ?? 'Unbekannte Firma'}</h3>
          <p className="mt-0.5 text-[13px] text-fg-muted">
            {[call?.leadName, when && `Anruf ${when}`, duration(call?.durationSec ?? null), call?.resultLabel].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {interest && (
            <Badge tone={interest.tone} size="md" dot>
              {interest.label}
            </Badge>
          )}
          <Badge tone="primary" variant="outline">
            KI-Vorschlag
          </Badge>
        </div>
      </header>

      <div className="space-y-4 px-5 py-4">
        {analysis.status === 'failed' || !result ? (
          <p className="flex items-center gap-2 text-sm text-warning">
            <TriangleAlert className="size-4" aria-hidden />
            {analysis.error ?? 'Die Analyse konnte nicht erstellt werden.'} Der Anruf bleibt mit deiner Notiz im CRM.
          </p>
        ) : (
          <>
            <p className="text-sm leading-relaxed whitespace-pre-line text-fg">{result.summary}</p>
            {result.interest.quote && (
              <blockquote className="flex gap-2 border-l-2 border-border-strong pl-3 text-[13px] text-fg-muted italic">
                <Quote className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>{result.interest.quote}</span>
              </blockquote>
            )}
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[13px]">
              {result.needs.length > 0 && (
                <>
                  <dt className="text-fg-subtle">Bedarf</dt>
                  <dd className="flex flex-wrap gap-1.5">
                    {result.needs.flatMap((n) => n.useCaseIds).filter((id, i, all) => all.indexOf(id) === i).map((id) => (
                      <Badge key={id} tone="neutral">
                        {useCaseLabel(id)}
                      </Badge>
                    ))}
                  </dd>
                </>
              )}
              <dt className="text-fg-subtle">Entscheider</dt>
              <dd className="text-fg">
                {result.decisionMaker.reached === 'yes'
                  ? 'erreicht'
                  : result.decisionMaker.reached === 'forwarded'
                    ? `weitergeleitet${result.decisionMaker.forwardedTo?.name ? ` an ${result.decisionMaker.forwardedTo.name}` : ''}${result.decisionMaker.forwardedTo?.jobtitle ? `, ${result.decisionMaker.forwardedTo.jobtitle}` : ''}`
                    : 'nicht erreicht'}
              </dd>
              {result.objections.length > 0 && (
                <>
                  <dt className="text-fg-subtle">Einwände</dt>
                  <dd className="text-fg">{result.objections.map((o) => OBJECTIONS[o]).join(', ')}</dd>
                </>
              )}
              {(result.suggestion.nextStep || result.suggestion.nextStepDate) && (
                <>
                  <dt className="text-fg-subtle">Nächster Schritt</dt>
                  <dd className="text-fg">
                    {[result.suggestion.nextStep, result.suggestion.nextStepDate && `bis ${formatZurich(`${result.suggestion.nextStepDate}T12:00:00Z`, 'dd.MM.yyyy')}`]
                      .filter(Boolean)
                      .join(' ')}
                  </dd>
                </>
              )}
            </dl>

            {(proposals.length > 0 || newContact || (result.suggestion.preparationNeeded && item.upcomingBookingIds.length > 0)) && (
              <section className="rounded-md border border-border bg-surface-2 p-3.5">
                <h4 className="mb-2 text-[13px] font-semibold text-fg">Die KI schlägt zusätzlich vor</h4>
                <p className="mb-3 text-xs text-fg-muted">Geht nur mit, wenn du es ankreuzt.</p>
                <ul className="space-y-2">
                  {proposals.map((op) => (
                    <li key={op.id}>
                      <Checkbox
                        checked={accepted.has(op.id)}
                        onChange={() => toggle(op.id)}
                        label={op.label}
                        description={
                          <span className="inline-flex items-center gap-1.5">
                            <span className="line-through decoration-fg-subtle">{valueText(op.oldValue, op.oldDisplay)}</span>
                            <ArrowRight className="size-3" aria-label="wird zu" />
                            <span className="font-medium text-fg">{valueText(op.newValue, op.newDisplay)}</span>
                          </span>
                        }
                      />
                    </li>
                  ))}
                  {newContact && (
                    <li>
                      <Checkbox
                        checked={acceptContact}
                        onChange={(e) => setAcceptContact(e.target.checked)}
                        label="Neue Ansprechperson als Lead anlegen"
                        description={[
                          [newContact.fields.firstname, newContact.fields.lastname].filter(Boolean).join(' '),
                          newContact.fields.jobtitle,
                          newContact.fields.emailaddress1,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      />
                    </li>
                  )}
                  {result.suggestion.preparationNeeded && item.upcomingBookingIds.length > 0 && (
                    <li>
                      <Checkbox
                        checked={applyPreparation}
                        onChange={(e) => setApplyPreparation(e.target.checked)}
                        label="Vorbereitung für den gebuchten Termin vormerken"
                        description="Das Briefing geht dann eine Woche vorher per Mail an Sales und Nico."
                      />
                    </li>
                  )}
                </ul>
              </section>
            )}

            {conflicts.length > 0 && (
              <section className="rounded-md border border-warning/40 bg-warning-subtle p-3.5" role="alert">
                <h4 className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-warning">
                  <TriangleAlert className="size-4" aria-hidden /> Im CRM inzwischen geändert – bitte entscheiden
                </h4>
                <ul className="space-y-2.5">
                  {conflicts.map((c) => (
                    <li key={c.opId} className="text-[13px]">
                      <p className="font-medium text-fg">{c.label}</p>
                      <p className="text-fg-muted">
                        Entwurf: {valueText(c.draftValue)} · CRM jetzt: {valueText(c.crmNow)} · neu: {valueText(c.newValue)}
                      </p>
                      <div className="mt-1.5 flex gap-2">
                        <Button size="sm" variant={resolutions[c.opId] === 'overwrite' ? 'subtle' : 'secondary'} onClick={() => setResolutions((r) => ({ ...r, [c.opId]: 'overwrite' }))}>
                          Überschreiben
                        </Button>
                        <Button size="sm" variant={resolutions[c.opId] === 'keep_crm' ? 'subtle' : 'secondary'} onClick={() => setResolutions((r) => ({ ...r, [c.opId]: 'keep_crm' }))}>
                          CRM-Wert behalten
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>

      {showDetails && changeSet && (
        <div className="border-t border-border px-5 py-4">
          <ChangeSetPreview changeSetId={changeSet.id} />
        </div>
      )}

      <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
        <div className="text-xs text-fg-subtle">
          {!call?.pushed && analysis.status === 'ready' ? 'Zuerst das Ergebnis des Anrufs freigeben – dann kannst du ergänzen.' : null}
          {changeSet && analysis.status === 'ready' && (
            <button type="button" className="inline-flex items-center gap-1 hover:text-fg" onClick={() => setShowDetails((s) => !s)} aria-expanded={showDetails}>
              {showDetails ? <ChevronUp className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
              Alle Änderungen ansehen
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" icon={X} onClick={() => dismiss.mutate()} loading={dismiss.isPending} kbd={active ? 'X' : undefined}>
            Verwerfen
          </Button>
          {analysis.status === 'ready' && (
            <Button variant="primary" icon={Check} onClick={() => submit()} loading={approve.isPending} disabled={!canApprove} kbd={active ? 'E' : undefined}>
              Ergänzen
            </Button>
          )}
        </div>
      </footer>
    </Card>
  );
}
