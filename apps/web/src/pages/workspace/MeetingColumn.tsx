/**
 * Rechte Spalte für Sales / KI-Spezialist (kein Coldcall): «Termin & Briefing» (INTENT 6.10 «im Portal ist das Briefing
 * beim Termin immer sichtbar»). Shows the lead's bookings and the briefing of the next one; the primary action
 * «Vorbereitung erledigt» lives in the BriefingView (shortcut P).
 */
import { formatZurich, type Booking } from '@sales-portal/shared';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/app/api';
import { Badge, Card, CardBody, CardHeader, cn, EmptyState, SkeletonText } from '@/components/ui';
import { BriefingView } from '@/pages/ai';

const ACTIVE: Booking['status'][] = ['booked', 'rescheduled'];
const STATUS_LABEL: Record<Booking['status'], string> = { booked: 'gebucht', rescheduled: 'verschoben', cancelled: 'abgesagt', held: 'stattgefunden' };

/** Next active booking first, then the rest (newest first). */
export function orderBookings(items: Booking[], now: number): Booking[] {
  const upcoming = items.filter((b) => ACTIVE.includes(b.status) && Date.parse(b.end) > now).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const rest = items.filter((b) => !upcoming.includes(b)).sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  return [...upcoming, ...rest];
}

export function MeetingColumn({ leadId, initialBookingId }: { leadId: string; initialBookingId?: string | null }) {
  const q = useQuery({
    queryKey: ['scheduling', 'bookings', 'lead', leadId],
    queryFn: () => api.get<{ items: Booking[] }>('/api/scheduling/bookings', { leadId }),
  });
  const ordered = useMemo(() => orderBookings(q.data?.items ?? [], Date.now()), [q.data]);
  const [selected, setSelected] = useState<string | null>(initialBookingId ?? null);
  useEffect(() => {
    if (!selected && ordered[0]) setSelected(ordered[0].id);
  }, [ordered, selected]);

  if (q.isLoading) {
    return (
      <Card className="p-4" aria-busy>
        <SkeletonText lines={6} />
      </Card>
    );
  }
  if (!ordered.length && !initialBookingId) {
    return (
      <Card>
        <EmptyState
          compact
          icon={CalendarClock}
          title="Kein Termin mit diesem Lead"
          description="Sobald ein Erstgespräch gebucht ist, erscheinen hier Termin und Briefing zur Vorbereitung."
        />
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {ordered.length > 0 && (
        <Card>
          <CardHeader title="Termin & Briefing" description="Nächster Termin zuerst" />
          <CardBody className="pt-0">
            <ul className="space-y-1" role="listbox" aria-label="Termine dieses Leads">
              {ordered.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected === b.id}
                    onClick={() => setSelected(b.id)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px]',
                      selected === b.id ? 'bg-primary-subtle text-primary' : 'text-fg hover:bg-surface-2',
                    )}
                  >
                    <span className="tabular">{formatZurich(b.start, 'dd.MM.yyyy HH:mm')}</span>
                    <Badge tone={ACTIVE.includes(b.status) ? 'info' : 'neutral'}>{STATUS_LABEL[b.status]}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
      {selected && <BriefingView key={selected} bookingId={selected} />}
    </div>
  );
}
