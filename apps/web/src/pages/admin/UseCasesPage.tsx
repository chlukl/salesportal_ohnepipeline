/**
 * Use Cases (INTENT 3: AI-Spezialist sieht und pflegt den Use-Case-Katalog; 6.17 Kampagnen-Kennung je Use Case).
 * Route /use-cases – read for Sales, AI-Spezialist, Admin; create/edit only when the server says `canEdit`
 * (AI-Spezialist, Admin). The server enforces both. All texts are rendered as plain text.
 */
import type { UseCaseEntry, UseCasesResponse } from '@sales-portal/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lightbulb, Pencil, Plus, Search } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '@/app/api';
import { useShortcut } from '@/app/shortcuts';
import { toast } from '@/app/toast';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Input, PageHeader, SkeletonText, Table, TBody, TD, TH, THead, Textarea, Toggle, TR } from '@/components/ui';
import { formatDateTime } from './common';

const QUERY_KEY = ['use-cases'] as const;
const ID_RE = /^[A-Z0-9][A-Z0-9_-]{0,38}[A-Z0-9]$/;

function matches(u: UseCaseEntry, q: string): boolean {
  if (!q) return true;
  const hay = [u.id, u.label, u.short, u.description, ...u.industries].join(' ').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => hay.includes(part));
}

export default function UseCasesPage() {
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: () => api.get<UseCasesResponse>('/api/admin/use-cases') });
  const qc = useQueryClient();
  const [editing, setEditing] = useState<UseCaseEntry | 'new' | null>(null);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const canEdit = query.data?.canEdit ?? false;
  const items = useMemo(() => (query.data?.items ?? []).filter((u) => matches(u, search.trim())), [query.data, search]);
  const activeCount = query.data?.items.filter((u) => u.active).length ?? 0;

  const toggle = useMutation({
    mutationFn: (u: UseCaseEntry) => api.put<UseCaseEntry>(`/api/admin/use-cases/${encodeURIComponent(u.id)}`, { active: !u.active }),
    onSuccess: (u) => {
      toast.success(u.active ? `${u.short} wieder aktiv` : `${u.short} ausgeblendet`, { action: { label: 'Rückgängig', onClick: () => toggle.mutate(u) } });
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (err) => toast.error('Nicht gespeichert', { description: errorMessage(err) }),
  });

  useShortcut('n', () => setEditing('new'), { description: 'Neuer Use Case', group: 'Use Cases', enabled: canEdit && !editing });
  useShortcut('f', () => searchRef.current?.focus(), { description: 'Use Cases durchsuchen', group: 'Use Cases' });

  return (
    <>
      <PageHeader
        title="Use Cases"
        description="Katalog der Anwendungsfälle mit der Kennung, die in den Kampagnen-Mails (Lemlist) steht."
        actions={
          canEdit && (
            <Button variant="primary" icon={Plus} kbd="N" onClick={() => setEditing('new')}>
              Neuer Use Case
            </Button>
          )
        }
      />
      <Card className="overflow-hidden">
        <CardHeader
          title={query.data ? `${activeCount} aktive Use Cases` : 'Use Cases'}
          description={
            canEdit
              ? 'Neue Kennungen zuerst hier anlegen, dann in Lemlist verwenden. Ausgeblendete Use Cases bleiben für ältere Mails lesbar.'
              : 'Nur lesen – den Katalog pflegt der AI-Spezialist.'
          }
          actions={
            <Input
              ref={searchRef}
              icon={Search}
              inputSize="sm"
              placeholder="Suchen (F)"
              aria-label="Use Cases durchsuchen"
              value={search}
              maxLength={100}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearch('');
                  e.currentTarget.blur();
                }
              }}
              className="w-64"
            />
          }
        />
        {query.isLoading ? (
          <div className="p-5" aria-busy="true">
            <SkeletonText lines={6} />
          </div>
        ) : query.isError ? (
          <EmptyState
            icon={Lightbulb}
            title="Use Cases nicht geladen"
            description={errorMessage(query.error)}
            action={
              <Button variant="secondary" onClick={() => void query.refetch()}>
                Nochmals versuchen
              </Button>
            }
          />
        ) : !items.length ? (
          <EmptyState
            icon={Lightbulb}
            title={search ? 'Nichts gefunden' : 'Noch keine Use Cases'}
            description={search ? 'Kein Use Case passt zur Suche. Suche nach Kennung, Titel oder Branche.' : 'Lege den ersten Use Case mit seiner Kampagnen-Kennung an.'}
            action={
              search ? (
                <Button variant="secondary" onClick={() => setSearch('')}>
                  Suche leeren
                </Button>
              ) : canEdit ? (
                <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>
                  Neuer Use Case
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Kennung</TH>
                <TH>Use Case</TH>
                <TH>Kurztext</TH>
                <TH>Passt zu</TH>
                <TH align="center">aktiv</TH>
                {canEdit && <TH />}
              </tr>
            </THead>
            <TBody>
              {items.map((u) => (
                <TR key={u.id} className={u.active ? undefined : 'opacity-60'}>
                  <TD className="w-36 align-top">
                    <span className="font-mono text-xs text-fg">{u.id}</span>
                  </TD>
                  <TD className="w-80 align-top">
                    <p className="font-medium text-fg">{u.label}</p>
                    <p className="text-xs text-fg-subtle">
                      Kurzname: {u.short}
                      {u.updatedAt && ` · geändert ${formatDateTime(u.updatedAt)}${u.updatedByName ? ` von ${u.updatedByName}` : ''}`}
                    </p>
                  </TD>
                  <TD className="align-top text-fg-muted">{u.description || <span className="text-fg-subtle">–</span>}</TD>
                  <TD className="w-72 align-top">
                    {u.industries.length ? (
                      <div className="flex flex-wrap gap-1">
                        {u.industries.map((i) => (
                          <Badge key={i}>{i}</Badge>
                        ))}
                      </div>
                    ) : (
                      <span className="text-fg-subtle">alle Branchen</span>
                    )}
                  </TD>
                  <TD align="center" className="align-top">
                    {canEdit ? (
                      <div className="flex justify-center">
                        <Toggle label={<span className="sr-only">{u.short} aktiv</span>} checked={u.active} disabled={toggle.isPending} onChange={() => toggle.mutate(u)} />
                      </div>
                    ) : (
                      <Badge tone={u.active ? 'success' : 'neutral'}>{u.active ? 'aktiv' : 'ausgeblendet'}</Badge>
                    )}
                  </TD>
                  {canEdit && (
                    <TD className="align-top">
                      <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(u)}>
                        Bearbeiten
                      </Button>
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      {editing && canEdit && <UseCaseDialog value={editing === 'new' ? null : editing} existingIds={query.data?.items.map((u) => u.id) ?? []} onClose={() => setEditing(null)} />}
    </>
  );
}

function UseCaseDialog({ value, existingIds, onClose }: { value: UseCaseEntry | null; existingIds: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [id, setId] = useState(value?.id ?? 'UC-');
  const [label, setLabel] = useState(value?.label ?? '');
  const [short, setShort] = useState(value?.short ?? '');
  const [description, setDescription] = useState(value?.description ?? '');
  const [industries, setIndustries] = useState((value?.industries ?? []).join(', '));
  const [active, setActive] = useState(value?.active ?? true);

  const normId = id.trim().toUpperCase();
  const idError = value ? null : !ID_RE.test(normId) ? 'Nur Grossbuchstaben, Ziffern, «-» oder «_», z. B. UC-LAGER' : existingIds.includes(normId) ? 'Diese Kennung gibt es schon' : null;
  const valid = !idError && label.trim() && short.trim();
  const industryList = industries
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const save = useMutation({
    mutationFn: () => {
      const body = { label, short, description, industries: industryList, active };
      return value ? api.put<UseCaseEntry>(`/api/admin/use-cases/${encodeURIComponent(value.id)}`, body) : api.post<UseCaseEntry>('/api/admin/use-cases', { id: normId, ...body });
    },
    onSuccess: (u) => {
      toast.success(value ? `${u.short} gespeichert` : `${u.short} hinzugefügt`);
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      onClose();
    },
    onError: (err) => toast.error('Nicht gespeichert', { description: errorMessage(err), duration: 10_000 }),
  });
  const submit = () => valid && !save.isPending && save.mutate();
  useShortcut('mod+enter', submit, { description: 'Use Case speichern', group: 'Use Cases', allowInInput: true });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={value ? `${value.short} bearbeiten` : 'Neuer Use Case'}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" kbd="Ctrl Enter" disabled={!valid} loading={save.isPending} onClick={submit}>
            Speichern
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {value ? (
          <p className="text-sm text-fg-muted">
            Kennung <span className="font-mono text-fg">{value.id}</span> – bleibt fest, damit ältere Kampagnen-Mails ihren Use Case behalten.
          </p>
        ) : (
          <Input
            label="Kennung (wie in Lemlist)"
            value={id}
            maxLength={40}
            onChange={(e) => setId(e.target.value.toUpperCase())}
            error={id.length > 3 ? idError : undefined}
            hint="Lässt sich später nicht mehr ändern. Erst hier anlegen, dann im Kampagnenschritt eintragen."
            className="font-mono"
            autoFocus
          />
        )}
        <Input label="Titel" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} placeholder="Lagerbestand automatisch abgleichen" autoFocus={!!value} />
        <Input label="Kurzname" value={short} maxLength={40} onChange={(e) => setShort(e.target.value)} hint="Für Betreffzeilen und Abzeichen, z. B. «Lager»." />
        <Textarea label="Kurztext" rows={3} maxLength={600} value={description} onChange={(e) => setDescription(e.target.value)} hint="Was der Kunde davon hat – in ein, zwei Sätzen Alltagssprache." />
        <Input label="Passt zu Branchen" value={industries} maxLength={1000} onChange={(e) => setIndustries(e.target.value)} placeholder="Logistik, Grosshandel" hint="Mit Komma trennen. Leer = alle Branchen." />
        <Toggle label="Aktiv" description="Ausgeblendete Use Cases werden nicht mehr vorgeschlagen, bleiben für ältere Mails aber lesbar." checked={active} onChange={setActive} />
      </div>
    </Dialog>
  );
}
