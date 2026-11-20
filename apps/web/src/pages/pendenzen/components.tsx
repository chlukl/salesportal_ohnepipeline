/** Building blocks of the Pendenzen page: row, «verschieben» menu, custom date dialog, saved filters. */
import type { PendenzEntry, PendenzFilter } from '@sales-portal/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, BookmarkPlus, CalendarClock, Check, ExternalLink, FileText, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '@/app/api';
import { toast } from '@/app/toast';
import { Badge, Button, Checkbox, cn, Dialog, DropdownMenu, IconButton, Input, type BadgeTone, type MenuSection } from '@/components/ui';
import { formatDue, fromLocalInput, rescheduleTargets, toLocalInput } from './format';
import { DUE_LABELS, iconFor, ORIGIN_LABELS } from './meta';

const TONE_ICON: Record<PendenzEntry['tone'], string> = {
  neutral: 'bg-surface-2 text-fg-muted',
  info: 'bg-info-subtle text-info',
  warning: 'bg-warning-subtle text-warning',
  danger: 'bg-danger-subtle text-danger',
  success: 'bg-success-subtle text-success',
};

// ---------------------------------------------------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------------------------------------------------

export interface RowHandlers {
  onOpen: (item: PendenzEntry) => void;
  onOpenBriefing: (item: PendenzEntry) => void;
  onDone: (item: PendenzEntry) => void;
  onReschedule: (item: PendenzEntry, at: string) => void;
  onPickDate: (item: PendenzEntry) => void;
}

export function PendenzRow({
  item,
  selected,
  busy,
  showOwner,
  onSelect,
  handlers,
}: {
  item: PendenzEntry;
  selected: boolean;
  busy: boolean;
  showOwner: boolean;
  onSelect: () => void;
  handlers: RowHandlers;
}) {
  const Icon = iconFor(item);
  const done = item.status === 'done';
  const dueText = formatDue(item.dueAt, item.due);
  const canDone = item.actions.includes('complete') || item.actions.includes('mark_done');
  const canMove = item.actions.includes('reschedule') || item.actions.includes('snooze');
  const canOpen = item.actions.includes('open_lead') && !!item.link;
  const canBriefing = item.actions.includes('open_briefing') && !!item.leadId;
  return (
    <li
      aria-selected={selected}
      onClick={onSelect}
      onDoubleClick={() => canOpen && handlers.onOpen(item)}
      className={cn(
        'group relative flex items-center gap-4 border-b border-border px-5 py-3.5 last:border-b-0',
        selected ? 'bg-primary-subtle/50' : 'hover:bg-surface-2/60',
        done && 'opacity-70',
      )}
    >
      {selected && <span className="absolute inset-y-0 left-0 w-[3px] bg-primary" aria-hidden />}
      <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-full', done ? TONE_ICON.success : TONE_ICON[item.tone])}>
        {done ? <Check className="size-4" aria-hidden /> : <Icon className="size-4" aria-hidden />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('truncate text-sm font-medium text-fg', done && 'line-through decoration-fg-subtle')}>{item.title}</span>
          {item.statusLabel && (
            <Badge tone={(done ? 'success' : item.tone === 'neutral' ? 'neutral' : item.tone) as BadgeTone}>{item.statusLabel}</Badge>
          )}
          {item.origin === 'campaign' && (
            <Badge tone="info" variant="outline">
              {ORIGIN_LABELS.campaign}
            </Badge>
          )}
        </div>
        {(item.subtitle || (showOwner && item.ownerName)) && (
          <p className="mt-0.5 truncate text-[13px] text-fg-muted" title={item.subtitle ?? undefined}>
            {[item.subtitle, showOwner && item.ownerName ? `für ${item.ownerName}` : null].filter(Boolean).join(' · ')}
          </p>
        )}
      </div>
      <div className="w-[150px] shrink-0 text-right">
        {dueText ? (
          <>
            <p className={cn('tabular text-[13px]', item.due === 'overdue' && !done ? 'font-medium text-warning' : 'text-fg-muted')}>{dueText}</p>
            {item.snoozedUntil ? (
              <p className="text-[11px] text-fg-subtle">verschoben</p>
            ) : item.due === 'overdue' && !done ? (
              <p className="text-[11px] text-warning">{DUE_LABELS.overdue}</p>
            ) : null}
          </>
        ) : (
          <p className="text-[13px] text-fg-subtle">–</p>
        )}
      </div>
      <div className="flex w-[244px] shrink-0 items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        {canDone && !done && (
          <Button size="sm" variant="secondary" icon={Check} loading={busy} onClick={() => handlers.onDone(item)}>
            Erledigt
          </Button>
        )}
        {canMove && !done && <RescheduleMenu item={item} onPick={(at) => handlers.onReschedule(item, at)} onCustom={() => handlers.onPickDate(item)} />}
        {canBriefing && <IconButton size="sm" icon={FileText} label="Briefing öffnen" onClick={() => handlers.onOpenBriefing(item)} />}
        {canOpen && <IconButton size="sm" icon={ExternalLink} label="Lead öffnen" onClick={() => handlers.onOpen(item)} />}
      </div>
    </li>
  );
}

export function RescheduleMenu({ item, onPick, onCustom }: { item: PendenzEntry; onPick: (at: string) => void; onCustom: () => void }) {
  const targets = rescheduleTargets();
  const sections: MenuSection[] = [
    {
      key: 'quick',
      title: item.kind === 'task' ? 'Aufgabe verschieben auf' : 'Wieder zeigen am',
      items: targets.map((t) => ({ key: t.key, label: t.label, onSelect: () => onPick(t.at) })),
    },
    { key: 'custom', items: [{ key: 'custom', label: 'Datum wählen …', icon: CalendarClock, onSelect: onCustom }] },
  ];
  return (
    <DropdownMenu
      sections={sections}
      width={250}
      trigger={({ open, toggle }) => (
        <IconButton size="sm" icon={CalendarClock} label="Verschieben" aria-expanded={open} aria-haspopup="menu" onClick={toggle} />
      )}
    />
  );
}

export function RescheduleDialog({ item, onClose, onSave }: { item: PendenzEntry | null; onClose: () => void; onSave: (at: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const initial = item ? toLocalInput(item.dueAt && new Date(item.dueAt) > new Date() ? item.dueAt : rescheduleTargets()[0].at) : '';
  const current = value || initial;
  const submit = () => {
    const at = fromLocalInput(current);
    if (!at) return setError('Bitte Datum und Zeit wählen');
    if (new Date(at).getTime() < Date.now() - 60_000) return setError('Das Datum liegt in der Vergangenheit');
    onSave(at);
    setValue('');
    setError(null);
  };
  return (
    <Dialog
      open={!!item}
      onClose={() => {
        setValue('');
        setError(null);
        onClose();
      }}
      size="sm"
      title="Verschieben"
      description={item?.title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={submit}>
            Verschieben
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          type="datetime-local"
          label={item?.kind === 'task' ? 'Neues Fälligkeitsdatum' : 'Wieder zeigen am'}
          value={current}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          error={error ?? undefined}
          autoFocus
        />
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Saved filters (scope 'pendenzen')
// ---------------------------------------------------------------------------------------------------------------------

export interface SavedPendenzFilter {
  id: string;
  name: string;
  filter: PendenzFilter;
  isDefault: boolean;
}

export const SAVED_FILTERS_KEY = ['pendenzen', 'filters'] as const;

export function useSavedFilters() {
  return useQuery({
    queryKey: SAVED_FILTERS_KEY,
    queryFn: () => api.get<{ items: SavedPendenzFilter[] }>('/api/pendenzen/filters'),
    staleTime: 60_000,
  });
}

function sameFilter(a: PendenzFilter, b: PendenzFilter): boolean {
  const norm = (f: PendenzFilter) =>
    JSON.stringify({
      kinds: [...(f.kinds ?? [])].sort(),
      due: [...(f.due ?? [])].sort(),
      origins: [...(f.origins ?? [])].sort(),
      company: f.company?.trim() || '',
      status: f.status ?? 'open',
      userId: f.userId ?? '',
    });
  return norm(a) === norm(b);
}

export function SavedFilters({ current, onApply }: { current: PendenzFilter; onApply: (filter: PendenzFilter) => void }) {
  const qc = useQueryClient();
  const { data } = useSavedFilters();
  const [dialog, setDialog] = useState(false);
  const [name, setName] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const items = data?.items ?? [];
  const active = items.find((f) => sameFilter(f.filter, current));

  const create = useMutation({
    mutationFn: () => api.post<SavedPendenzFilter>('/api/pendenzen/filters', { name: name.trim(), filter: stripEmpty(current), isDefault }),
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: SAVED_FILTERS_KEY });
      toast.success(`Filter «${saved.name}» gespeichert`);
      setName('');
      setIsDefault(false);
      setDialog(false);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (f: SavedPendenzFilter) => api.del(`/api/pendenzen/filters/${f.id}`).then(() => f),
    onSuccess: (f) => {
      void qc.invalidateQueries({ queryKey: SAVED_FILTERS_KEY });
      toast.info(`Filter «${f.name}» gelöscht`, {
        action: {
          label: 'Rückgängig',
          onClick: () =>
            void api
              .post('/api/pendenzen/filters', { name: f.name, filter: f.filter, isDefault: f.isDefault })
              .then(() => qc.invalidateQueries({ queryKey: SAVED_FILTERS_KEY }))
              .catch((err) => toast.error(errorMessage(err))),
        },
      });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const makeDefault = useMutation({
    mutationFn: (f: SavedPendenzFilter) => api.put(`/api/pendenzen/filters/${f.id}`, { isDefault: !f.isDefault }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: SAVED_FILTERS_KEY }),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const sections: MenuSection[] = [];
  if (items.length) {
    sections.push({
      key: 'saved',
      title: 'Gespeicherte Filter',
      items: items.map((f) => ({
        key: f.id,
        label: f.name,
        icon: f.isDefault ? Star : Bookmark,
        checked: active?.id === f.id,
        onSelect: () => onApply(f.filter),
      })),
    });
  }
  sections.push({
    key: 'actions',
    items: [{ key: 'save', label: items.length ? 'Filter speichern / verwalten …' : 'Aktuellen Filter speichern …', icon: BookmarkPlus, onSelect: () => setDialog(true) }],
  });

  return (
    <>
      <DropdownMenu
        sections={sections}
        width={280}
        trigger={({ open, toggle }) => (
          <Button size="md" variant="secondary" icon={Bookmark} onClick={toggle} aria-expanded={open} aria-haspopup="menu">
            {active ? active.name : 'Filter'}
          </Button>
        )}
      />
      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title="Filter speichern"
        description="Speichert Art, Fälligkeit, Herkunft, Firma, Status und Person – wie in der Anrufliste."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(false)}>
              Schliessen
            </Button>
            <Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>
              Speichern
            </Button>
          </>
        }
      >
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <Input label="Name" placeholder="z. B. Rückrufe heute" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoFocus />
          <Checkbox label="Beim Öffnen der Pendenzen verwenden" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        </form>
        {items.length > 0 && (
          <div className="mt-5 border-t border-border pt-4">
            <p className="mb-2 text-xs font-semibold tracking-wide text-fg-subtle uppercase">Gespeichert</p>
            <ul className="space-y-1">
              {items.map((f) => (
                <li key={f.id} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-surface-2">
                  <span className="flex-1 truncate">{f.name}</span>
                  {f.isDefault && <Badge tone="primary">Standard</Badge>}
                  <IconButton size="sm" icon={Star} label={f.isDefault ? 'Nicht mehr Standard' : 'Als Standard verwenden'} onClick={() => makeDefault.mutate(f)} />
                  <IconButton size="sm" icon={Trash2} label="Löschen" onClick={() => remove.mutate(f)} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </Dialog>
    </>
  );
}

export function stripEmpty(filter: PendenzFilter): PendenzFilter {
  const out: PendenzFilter = {};
  if (filter.kinds?.length) out.kinds = filter.kinds;
  if (filter.due?.length) out.due = filter.due;
  if (filter.origins?.length) out.origins = filter.origins;
  if (filter.company?.trim()) out.company = filter.company.trim();
  if (filter.status && filter.status !== 'open') out.status = filter.status;
  if (filter.userId) out.userId = filter.userId;
  return out;
}
