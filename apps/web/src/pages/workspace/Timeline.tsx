/** Verlauf (INTENT 6.2 Mitte): notes, calls, mails, appointments, tasks – newest first. CRM text is rendered as text. */
import { formatZurich, optionLabel, useCaseLabel, type TimelineItem } from '@sales-portal/shared';
import { CalendarDays, CheckSquare, ChevronDown, Mail, Megaphone, Phone, PhoneIncoming, StickyNote } from 'lucide-react';
import { useState } from 'react';
import { Badge, cn, EmptyState, Tabs } from '@/components/ui';

type Kind = 'all' | 'phonecall' | 'note' | 'email' | 'appointment' | 'task';

const ICONS = { phonecall: Phone, note: StickyNote, email: Mail, appointment: CalendarDays, task: CheckSquare };
/** Title of an entry without subject – never the raw CRM type. */
const TYPE_LABELS: Record<TimelineItem['type'], string> = { phonecall: 'Anruf', note: 'Notiz', email: 'Mail', appointment: 'Termin', task: 'Aufgabe' };

function duration(sec: number | null): string | null {
  if (sec == null || sec <= 0) return null;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} Min.`;
}

function Item({ item }: { item: TimelineItem }) {
  const [open, setOpen] = useState(false);
  const Icon = item.isCampaign ? Megaphone : item.type === 'phonecall' && item.direction === 'incoming' ? PhoneIncoming : ICONS[item.type];
  const long = (item.text?.length ?? 0) > 220;
  const cancelled = item.statecode === 2;
  return (
    <li className={cn('relative flex gap-3 pb-4 pl-1', cancelled && 'opacity-50')}>
      <span
        className={cn(
          'z-10 flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface',
          item.isRealContact ? 'text-primary' : 'text-fg-subtle',
        )}
      >
        <Icon className="size-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[13px] font-medium text-fg">{item.subject ?? TYPE_LABELS[item.type] ?? 'Eintrag'}</span>
          <span className="tabular text-xs text-fg-subtle">{formatZurich(item.at, 'dd.MM.yyyy HH:mm')}</span>
          {item.ownerName && <span className="text-xs text-fg-subtle">· {item.ownerName}</span>}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-1">
          {item.resultCode != null && <Badge tone={item.isRealContact ? 'primary' : 'neutral'}>{optionLabel('kls_anrufergebnis', item.resultCode)}</Badge>}
          {duration(item.durationSec) && <Badge>{duration(item.durationSec)}</Badge>}
          {item.interest != null && <Badge tone="info">Interesse {optionLabel('kls_interesse', item.interest)}</Badge>}
          {item.isPortalNote && <Badge>Portal-Notiz</Badge>}
          {item.type === 'task' && <Badge tone={item.statecode === 0 ? 'warning' : 'neutral'}>{item.statecode === 0 ? 'offen' : item.statecode === 1 ? 'erledigt' : 'geschlossen'}</Badge>}
          {cancelled && item.type !== 'task' && <Badge>zurückgesetzt</Badge>}
          {item.campaign && (
            <>
              <Badge tone="info">
                {item.campaign.campaignName} · Schritt {item.campaign.step}
              </Badge>
              {item.campaign.useCaseIds.map((u) => (
                <Badge key={u} variant="outline">
                  {useCaseLabel(u)}
                </Badge>
              ))}
              {item.campaign.reactions
                .filter((r) => r.kind !== 'opened')
                .map((r, i) => (
                  <Badge key={i} tone={r.kind === 'replied_positive' ? 'success' : r.kind === 'replied_negative' || r.kind === 'unsubscribed' ? 'danger' : 'neutral'}>
                    {{ clicked: 'Klick', replied: 'Antwort', replied_positive: 'positive Antwort', replied_negative: 'Absage', bounced: 'unzustellbar', unsubscribed: 'abgemeldet', opened: 'geöffnet' }[r.kind]}
                  </Badge>
                ))}
            </>
          )}
        </div>
        {item.text && (
          <p className={cn('mt-1 text-[13px] leading-relaxed whitespace-pre-wrap text-fg-muted', !open && long && 'line-clamp-3')}>{item.text}</p>
        )}
        {long && (
          <button type="button" className="mt-0.5 text-xs font-medium text-primary hover:underline" onClick={() => setOpen((o) => !o)}>
            {open ? 'weniger' : 'ganzer Text'}
          </button>
        )}
      </div>
    </li>
  );
}

export function Timeline({ items, collapsedByDefault = false }: { items: TimelineItem[]; collapsedByDefault?: boolean }) {
  const [kind, setKind] = useState<Kind>('all');
  const [collapsed, setCollapsed] = useState(collapsedByDefault);
  const [limit, setLimit] = useState(25);
  const count = (k: Kind) => (k === 'all' ? items.length : items.filter((i) => i.type === k).length);
  const shown = items.filter((i) => kind === 'all' || i.type === kind);
  const tabs = (['all', 'phonecall', 'note', 'email', 'appointment', 'task'] as Kind[])
    .filter((k) => k === 'all' || count(k) > 0)
    .map((k) => ({ id: k, label: { all: 'Alle', phonecall: 'Anrufe', note: 'Notizen', email: 'Mails', appointment: 'Termine', task: 'Aufgaben' }[k], count: count(k) }));

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="flex w-full items-center justify-between rounded-md border border-dashed border-border-strong px-3 py-2 text-[13px] text-fg-muted hover:bg-surface-2 hover:text-fg"
      >
        Voller Verlauf ({items.length} Einträge) <ChevronDown className="size-4" aria-hidden />
      </button>
    );
  }
  return (
    <div>
      {items.length > 0 && <Tabs items={tabs} value={kind} onChange={setKind} variant="pill" label="Verlauf filtern" className="mb-3" />}
      {shown.length === 0 ? (
        <EmptyState compact title="Noch kein Verlauf" description="Nach dem ersten Anruf steht hier die Telefonaktivität mit Ergebnis und Notiz." />
      ) : (
        <ol className="relative before:absolute before:top-2 before:bottom-4 before:left-[17px] before:w-px before:bg-border">
          {shown.slice(0, limit).map((i) => (
            <Item key={i.id} item={i} />
          ))}
        </ol>
      )}
      {shown.length > limit && (
        <button type="button" className="text-[13px] font-medium text-primary hover:underline" onClick={() => setLimit((l) => l + 50)}>
          Ältere Einträge zeigen ({shown.length - limit})
        </button>
      )}
      {collapsedByDefault && (
        <button type="button" className="mt-2 text-xs text-fg-subtle hover:text-fg" onClick={() => setCollapsed(true)}>
          Verlauf einklappen
        </button>
      )}
    </div>
  );
}
