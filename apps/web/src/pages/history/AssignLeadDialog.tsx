/**
 * «Nicht im CRM» → Nummer einem Lead zuordnen (INTENT 6.18). Sucht Leads nach Name/Firma und speichert die Zuordnung
 * im Portal (das CRM bleibt unverändert). Wird von der Anrufhistorie und der Rückruf-Suche in der Kopfleiste genutzt.
 */
import type { CallbackSearchResponse } from '@sales-portal/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Link2, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/app/api';
import { toast } from '@/app/toast';
import { Button, Dialog, EmptyState, Input, Skeleton } from '@/components/ui';

interface Assignment {
  id: string;
  phoneE164: string;
  leadId: string;
  leadName: string | null;
  companyName: string | null;
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function AssignLeadDialog({
  phone,
  phoneDisplay,
  onClose,
  onAssigned,
}: {
  /** Number to assign (any format); null = closed. */
  phone: string | null;
  phoneDisplay?: string | null;
  onClose: () => void;
  onAssigned?: (assignment: Assignment) => void;
}) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim());
  const enabled = !!phone && debounced.length >= 2 && /[a-zà-ÿ]/i.test(debounced);
  const search = useQuery({
    queryKey: ['callback-search', 'assign', debounced],
    queryFn: ({ signal }) => api.get<CallbackSearchResponse>('/api/history/callback-search', { q: debounced }, signal),
    enabled,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['history'] });
    void qc.invalidateQueries({ queryKey: ['callback-search'] });
    void qc.invalidateQueries({ queryKey: ['me', 'counters'] });
  };

  const assign = useMutation({
    mutationFn: (leadId: string) => api.post<Assignment>('/api/history/assignments', { phone, leadId }),
    onSuccess: (a) => {
      refresh();
      toast.success(`Nummer zugeordnet: ${a.companyName ?? a.leadName ?? 'Lead'}`, {
        description: 'Nur im Portal gespeichert – das CRM bleibt unverändert.',
        action: {
          label: 'Rückgängig',
          onClick: () =>
            void api
              .del(`/api/history/assignments/${a.id}`)
              .then(refresh)
              .catch((err) => toast.error(errorMessage(err))),
        },
      });
      setQ('');
      onAssigned?.(a);
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const hits = (search.data?.hits ?? []).filter((h) => h.leadId);
  return (
    <Dialog
      open={!!phone}
      onClose={() => {
        setQ('');
        onClose();
      }}
      title="Nummer einem Lead zuordnen"
      description={`${phoneDisplay ?? phone ?? ''} ist nicht im CRM. Wähle den Lead, zu dem die Nummer gehört – beim nächsten Anruf erkennt das Portal ihn.`}
    >
      <Input icon={Search} label="Lead suchen" placeholder="Name oder Firma" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="mt-3 min-h-[180px]">
        {!enabled ? (
          <p className="px-1 py-6 text-center text-sm text-fg-subtle">Mindestens zwei Buchstaben eingeben.</p>
        ) : search.isLoading ? (
          <div className="space-y-2" aria-busy="true">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : hits.length === 0 ? (
          <EmptyState compact icon={Building2} title="Kein Lead gefunden" description="Anders schreiben oder nur den Firmennamen eingeben." />
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {hits.map((h) => (
              <li key={h.key} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">{h.companyName ?? h.name}</p>
                  <p className="truncate text-xs text-fg-muted">{[h.companyName ? h.name : null, h.phoneDisplay].filter(Boolean).join(' · ')}</p>
                </div>
                <Button size="sm" variant="secondary" icon={Link2} loading={assign.isPending && assign.variables === h.leadId} onClick={() => assign.mutate(h.leadId!)}>
                  Zuordnen
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
