/** Protokoll (audit_log mit Filtern, Seiten, alt → neu, Zurücksetzen als neuer Entwurf) und Fehler (CRM-Push, Jobs). */
import type { AdminErrorItem, AuditEntry, Paged } from '@sales-portal/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, ExternalLink, RotateCcw, ScrollText, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, errorMessage } from '@/app/api';
import { useShortcut } from '@/app/shortcuts';
import { toast } from '@/app/toast';
import { Badge, Button, Card, CardHeader, EmptyState, IconButton, Input, Select, SkeletonText, Table, TBody, TD, TH, THead, TR } from '@/components/ui';
import { actionLabel, displayValue, formatDateTime } from './common';

type AuditItem = AuditEntry & { revertable: boolean };
interface Facets {
  actions: string[];
  entities: string[];
  actors: { id: string; name: string }[];
}
interface Filters {
  action: string;
  entity: string;
  actorUserId: string;
  entityId: string;
  from: string;
  to: string;
}
const EMPTY: Filters = { action: '', entity: '', actorUserId: '', entityId: '', from: '', to: '' };
const PAGE_SIZE = 50;

const ENTITY_LABELS: Record<string, string> = {
  lead: 'Lead',
  user: 'Person',
  session: 'Sitzung',
  setting: 'Einstellung',
  template: 'Vorlage',
  objection: 'Einwand',
  result_group_rule: 'Ergebnisgruppe',
  job: 'Job',
  phonecall: 'Telefonaktivität',
  task: 'Aufgabe',
  transcript: 'Transkript',
  weekly_report: 'Wochenreport',
  secret: 'Geheimnis',
};

/** Zurich wall date (YYYY-MM-DD) → ISO instant of local midnight (approximation via browser offset is not used). */
function zurichMidnightIso(date: string): string {
  const probe = new Date(`${date}T12:00:00Z`);
  const zurichNoon = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hour: '2-digit', hourCycle: 'h23' }).format(probe);
  const offsetH = Number(zurichNoon) - 12;
  return new Date(Date.parse(`${date}T00:00:00Z`) - offsetH * 3_600_000).toISOString();
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export function AuditTab() {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const facets = useQuery({ queryKey: ['admin', 'audit', 'facets'], queryFn: () => api.get<Facets>('/api/admin/audit/facets'), staleTime: 60_000 });
  const params = {
    page,
    pageSize: PAGE_SIZE,
    action: filters.action || undefined,
    entity: filters.entity || undefined,
    actorUserId: filters.actorUserId || undefined,
    entityId: filters.entityId.trim() || undefined,
    from: filters.from ? zurichMidnightIso(filters.from) : undefined,
    to: filters.to ? zurichMidnightIso(nextDay(filters.to)) : undefined,
  };
  const audit = useQuery({
    queryKey: ['admin', 'audit', params],
    queryFn: ({ signal }) => api.get<Paged<AuditItem>>('/api/admin/audit', params, signal),
    placeholderData: (prev) => prev,
  });
  const qc = useQueryClient();
  const revert = useMutation({
    mutationFn: (id: number) => api.post<{ changeSetId: string }>(`/api/admin/audit/${id}/revert`),
    onSuccess: () => {
      toast.success('Entwurf zum Zurücksetzen erstellt', { description: 'Er erscheint zur Freigabe mit Vorschau alt → neu. Im CRM ändert sich erst nach der Freigabe etwas.' });
      void qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const update = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  const totalPages = audit.data ? Math.max(1, Math.ceil(audit.data.total / PAGE_SIZE)) : 1;
  useShortcut('arrowright', () => page < totalPages && setPage(page + 1), { description: 'Protokoll: nächste Seite', group: 'Admin' });
  useShortcut('arrowleft', () => page > 1 && setPage(page - 1), { description: 'Protokoll: vorherige Seite', group: 'Admin' });

  const actionPrefixes = [...new Set((facets.data?.actions ?? []).map((a) => `${a.split('.')[0]}.`))];
  const hasFilter = JSON.stringify(filters) !== JSON.stringify(EMPTY);

  return (
    <Card className="overflow-hidden">
      <CardHeader title="Protokoll" description="Wer hat wann was geändert – CRM-Änderungen mit altem Wert (zum Zurücksetzen) und alle Admin-Aktionen." />
      <div className="grid grid-cols-6 gap-3 border-b border-border px-5 pb-4">
        <Select
          label="Aktion"
          selectSize="sm"
          value={filters.action}
          placeholder="alle"
          options={[
            ...actionPrefixes.map((p) => ({ value: p, label: `${p.slice(0, -1)} (alle)` })),
            ...(facets.data?.actions ?? []).map((a) => ({ value: a, label: actionLabel(a) })),
          ]}
          onChange={(e) => update({ action: e.target.value })}
        />
        <Select label="Objekt" selectSize="sm" value={filters.entity} placeholder="alle" options={(facets.data?.entities ?? []).map((e) => ({ value: e, label: ENTITY_LABELS[e] ?? e }))} onChange={(e) => update({ entity: e.target.value })} />
        <Select label="Wer" selectSize="sm" value={filters.actorUserId} placeholder="alle" options={(facets.data?.actors ?? []).map((a) => ({ value: a.id, label: a.name }))} onChange={(e) => update({ actorUserId: e.target.value })} />
        <Input label="Objekt-ID" inputSize="sm" value={filters.entityId} placeholder="z. B. Lead-ID" onChange={(e) => update({ entityId: e.target.value })} />
        <Input label="von" inputSize="sm" type="date" value={filters.from} onChange={(e) => update({ from: e.target.value })} />
        <Input label="bis" inputSize="sm" type="date" value={filters.to} onChange={(e) => update({ to: e.target.value })} />
      </div>
      {audit.isLoading ? (
        <div className="p-5">
          <SkeletonText lines={8} />
        </div>
      ) : !audit.data?.items.length ? (
        <EmptyState
          icon={ScrollText}
          title={hasFilter ? 'Keine Einträge für diese Filter' : 'Noch keine Einträge'}
          description={hasFilter ? 'Filter lockern oder zurücksetzen.' : 'Sobald jemand etwas ändert, steht es hier.'}
          action={hasFilter ? <Button onClick={() => update(EMPTY)}>Filter zurücksetzen</Button> : undefined}
        />
      ) : (
        <>
          <Table dense>
            <THead>
              <tr>
                <TH>Zeit</TH>
                <TH>Wer</TH>
                <TH>Aktion</TH>
                <TH>Objekt</TH>
                <TH>Feld</TH>
                <TH>alt → neu</TH>
                <TH />
              </tr>
            </THead>
            <TBody>
              {audit.data.items.map((e) => (
                <TR key={e.id}>
                  <TD className="tabular whitespace-nowrap text-fg-muted">{formatDateTime(e.at)}</TD>
                  <TD className="whitespace-nowrap">{e.actorLabel}</TD>
                  <TD className="whitespace-nowrap">{actionLabel(e.action)}</TD>
                  <TD className="max-w-48">
                    <span className="text-fg-muted">{ENTITY_LABELS[e.entity] ?? e.entity}</span>
                    {e.entityId && (
                      <span className="block truncate font-mono text-xs text-fg-subtle" title={e.entityId}>
                        {e.entity === 'lead' ? (
                          <Link className="text-primary hover:underline" to={`/lead/${encodeURIComponent(e.entityId)}`}>
                            {e.entityId}
                          </Link>
                        ) : (
                          e.entityId
                        )}
                      </span>
                    )}
                  </TD>
                  <TD className="font-mono text-xs">{e.field ?? ''}</TD>
                  <TD className="max-w-[520px]">
                    {e.oldValue == null && e.newValue == null ? (
                      <span className="text-xs text-fg-subtle">{e.meta ? displayValue(null, e.meta) : ''}</span>
                    ) : (
                      <span className="flex items-start gap-2 text-[13px]">
                        <span className="line-clamp-2 text-fg-muted line-through decoration-fg-subtle/60" title={displayValue(e.field, e.oldValue)}>
                          {displayValue(e.field, e.oldValue)}
                        </span>
                        <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" aria-label="neu" />
                        <span className="line-clamp-2 text-fg" title={displayValue(e.field, e.newValue)}>
                          {displayValue(e.field, e.newValue)}
                        </span>
                      </span>
                    )}
                  </TD>
                  <TD align="right">
                    {e.revertable && (
                      <Button size="sm" variant="ghost" icon={Undo2} loading={revert.isPending && revert.variables === e.id} onClick={() => revert.mutate(e.id)}>
                        Zurücksetzen
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <div className="flex items-center justify-between border-t border-border px-5 py-3 text-sm text-fg-muted">
            <span className="tabular">
              {audit.data.total.toLocaleString('de-CH')} Einträge · Seite {page} von {totalPages}
            </span>
            <div className="flex gap-1">
              <IconButton icon={ChevronLeft} label="Vorherige Seite (←)" disabled={page <= 1} onClick={() => setPage(page - 1)} />
              <IconButton icon={ChevronRight} label="Nächste Seite (→)" disabled={page >= totalPages} onClick={() => setPage(page + 1)} />
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

export function ErrorsTab() {
  const qc = useQueryClient();
  const errors = useQuery({ queryKey: ['admin', 'errors'], queryFn: () => api.get<{ items: AdminErrorItem[] }>('/api/admin/errors'), refetchInterval: 30_000 });
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/api/admin/errors/jobs/${id}/retry`),
    onSuccess: () => {
      toast.success('Job neu gestartet');
      void qc.invalidateQueries({ queryKey: ['admin', 'errors'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Fehler" description="Fehlgeschlagene CRM-Pushes und Hintergrundjobs. Entwürfe gehen nie verloren – sie bleiben im Portal." />
      {errors.isLoading ? (
        <div className="p-5">
          <SkeletonText lines={5} />
        </div>
      ) : !errors.data?.items.length ? (
        <EmptyState icon={CheckCircle2} title="Keine Fehler" description="Alle CRM-Pushes und Hintergrundjobs sind durchgelaufen." />
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Zeit</TH>
              <TH>Was</TH>
              <TH>Fehlermeldung</TH>
              <TH>Lead</TH>
              <TH />
            </tr>
          </THead>
          <TBody>
            {errors.data.items.map((e) => (
              <TR key={`${e.source}:${e.id}`}>
                <TD className="tabular whitespace-nowrap text-fg-muted">{formatDateTime(e.at)}</TD>
                <TD>
                  <span className="font-medium">{e.title}</span>
                  <span className="block text-xs text-fg-subtle">
                    {e.source === 'change_set' ? `Entwurf von ${e.actorName ?? 'unbekannt'}` : `${e.attempts ?? 0} Versuche`}
                  </span>
                </TD>
                <TD className="max-w-md text-[13px] text-fg-muted">
                  <span className="line-clamp-3" title={e.error ?? ''}>
                    {e.error ?? '–'}
                  </span>
                </TD>
                <TD>
                  {e.leadId ? (
                    <Link to={`/lead/${encodeURIComponent(e.leadId)}`} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                      öffnen <ExternalLink className="size-3.5" aria-hidden />
                    </Link>
                  ) : (
                    '–'
                  )}
                </TD>
                <TD align="right">
                  {e.retryable ? (
                    <Button size="sm" icon={RotateCcw} loading={retry.isPending && retry.variables === e.id} onClick={() => retry.mutate(e.id)}>
                      Neu starten
                    </Button>
                  ) : e.source === 'change_set' ? (
                    <Badge tone="warning">im Arbeitsplatz erneut freigeben</Badge>
                  ) : (
                    <Badge>wird automatisch wiederholt</Badge>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
