/**
 * Briefing zum Erstgespräch (INTENT 6.10, 6.17) für den gebuchten Sales und Nico. Bei Kampagnen-Terminen stehen die
 * erhaltenen Mails zuoberst. Status: offen → gelesen (beim Öffnen) → Vorbereitung erledigt.
 */
import { formatZurich, useCaseLabel, type BriefingStatus, type CampaignReactionKind } from '@sales-portal/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CheckCircle2, FileText, Mail, Megaphone, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { api, errorMessage } from '@/app/api';
import { useShortcut } from '@/app/shortcuts';
import { toast } from '@/app/toast';
import { Badge, Button, Card, EmptyState, Skeleton, SkeletonText, type BadgeTone } from '@/components/ui';
import type { BriefingViewResponse } from './types';

export interface BriefingViewProps {
  bookingId: string;
}

const STATUS: Record<BriefingStatus, { label: string; tone: BadgeTone }> = {
  open: { label: 'offen', tone: 'warning' },
  read: { label: 'gelesen', tone: 'info' },
  prepared: { label: 'Vorbereitung erledigt', tone: 'success' },
};

const REACTIONS: Record<CampaignReactionKind, string> = {
  opened: 'geöffnet',
  clicked: 'Link geklickt',
  replied: 'geantwortet',
  replied_positive: 'positiv geantwortet',
  replied_negative: 'negativ geantwortet',
  bounced: 'unzustellbar',
  unsubscribed: 'abgemeldet',
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-fg-subtle uppercase">{title}</h4>
      <div className="text-sm leading-relaxed text-fg">{children}</div>
    </section>
  );
}

function Bullets({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="text-fg-muted">{empty}</p>;
  return (
    <ul className="list-disc space-y-1 pl-5">
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  );
}

export function BriefingView({ bookingId }: BriefingViewProps) {
  const queryClient = useQueryClient();
  const key = ['ai', 'briefing', bookingId];
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: key,
    queryFn: () => api.get<BriefingViewResponse>(`/api/ai/briefings/${bookingId}`),
    refetchInterval: (q) => (q.state.data && !q.state.data.briefing ? 10_000 : false),
  });

  const status = useMutation({
    mutationFn: (s: BriefingStatus) => api.post<{ status: BriefingStatus }>(`/api/ai/briefings/${bookingId}/status`, { status: s }),
    onSuccess: (res) => {
      queryClient.setQueryData<BriefingViewResponse>(key, (old) => (old ? { ...old, booking: { ...old.booking, briefingStatus: res.status } } : old));
      void queryClient.invalidateQueries({ queryKey: ['pendenzen'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const regenerate = useMutation({
    mutationFn: () => api.post(`/api/ai/briefings/${bookingId}/regenerate`),
    onSuccess: () => toast.info('Briefing wird neu erstellt', { description: 'Das dauert einen Moment.' }),
    onError: (err) => toast.error(errorMessage(err)),
  });

  // Opening the briefing marks it as read (only for the participants).
  const markedRead = useRef(false);
  useEffect(() => {
    if (!data?.briefing || !data.canUpdateStatus || data.booking.briefingStatus !== 'open' || markedRead.current) return;
    markedRead.current = true;
    status.mutate('read');
  }, [data, status]);

  const canPrepare = !!data?.canUpdateStatus && !!data.briefing && data.booking.briefingStatus !== 'prepared';
  useShortcut('p', () => status.mutate('prepared'), { description: 'Vorbereitung erledigt', group: 'Briefing', enabled: canPrepare && !status.isPending });

  if (isLoading) {
    return (
      <Card className="p-5" aria-busy>
        <Skeleton className="mb-4 h-5 w-1/3" />
        <SkeletonText lines={6} />
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card>
        <EmptyState
          compact
          icon={TriangleAlert}
          title="Briefing nicht verfügbar"
          description="Der Termin existiert nicht mehr oder du bist nicht eingeladen."
          action={<Button onClick={() => void refetch()}>Erneut laden</Button>}
        />
      </Card>
    );
  }

  const { booking, briefing, delivery, participants } = data;
  const st = STATUS[booking.briefingStatus];
  const when = `${formatZurich(booking.start, 'dd.MM.yyyy')} · ${formatZurich(booking.start, 'HH:mm')}–${formatZurich(booking.end, 'HH:mm')}`;
  const cancelled = booking.status === 'cancelled';

  return (
    <Card className="overflow-hidden">
      <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h3 className="truncate text-[17px] font-semibold text-fg">Briefing: {booking.companyName ?? 'Erstgespräch'}</h3>
          <p className="mt-0.5 text-[13px] text-fg-muted">
            {when}
            {participants.sales || participants.specialist ? ` · mit ${[participants.sales, participants.specialist].filter(Boolean).join(' und ')}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {cancelled && <Badge tone="danger">abgesagt</Badge>}
          {booking.origin === 'campaign' && (
            <Badge tone="primary" variant="outline">
              aus Kampagne
            </Badge>
          )}
          <Badge tone={st.tone} dot size="md">
            {st.label}
          </Badge>
        </div>
      </header>

      {!briefing ? (
        <EmptyState
          compact
          icon={FileText}
          title="Briefing wird erstellt"
          description="Die KI stellt Firma, Verlauf und Use Cases zusammen. Das dauert meist weniger als eine Minute."
          action={
            <Button icon={RefreshCw} onClick={() => regenerate.mutate()} loading={regenerate.isPending}>
              Jetzt erstellen
            </Button>
          }
        />
      ) : (
        <div className="grid gap-6 px-5 py-5">
          {(briefing.campaignContext || data.campaignMails.length > 0) && (
            <section className="rounded-md border border-primary/30 bg-primary-subtle/50 p-4">
              <h4 className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-primary">
                <Megaphone className="size-4" aria-hidden /> Kontakt kam über die Kampagne
              </h4>
              {data.campaignMails.length > 0 ? (
                <ul className="space-y-2 text-[13px]">
                  {data.campaignMails.map((m) => (
                    <li key={m.id}>
                      <p className="text-fg">
                        <span className="font-medium">«{m.subject}»</span> von {m.senderName}, {formatZurich(m.sentAt, 'dd.MM.yyyy')}
                      </p>
                      <p className="text-fg-muted">
                        {m.useCaseIds.length ? `Use Cases: ${m.useCaseIds.map(useCaseLabel).join(', ')}` : 'ohne Use-Case-Kennung'}
                        {' · '}
                        Reaktion: {m.reactions.length ? m.reactions.map((r) => REACTIONS[r.kind] ?? r.kind).join(', ') : 'keine'}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] whitespace-pre-line text-fg">{briefing.campaignContext}</p>
              )}
            </section>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <Section title="Firma">{briefing.profile || briefing.company}</Section>
            <Section title="Ansprechperson">{briefing.contact}</Section>
          </div>
          <Section title="Verlauf">
            <p className="whitespace-pre-line">{briefing.history}</p>
          </Section>
          <Section title="Use Cases">
            {briefing.useCases.length ? (
              <ul className="space-y-1.5">
                {briefing.useCases.map((u) => (
                  <li key={u.id}>
                    <span className="font-medium">{useCaseLabel(u.id)}</span>
                    <span className="text-fg-muted"> – {u.why}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-fg-muted">Keine passenden Use Cases gefunden.</p>
            )}
          </Section>
          <div className="grid gap-6 lg:grid-cols-3">
            <Section title="Einstiegsfragen">
              <Bullets items={briefing.openingQuestions} empty="–" />
            </Section>
            <Section title="Offene Punkte">
              <Bullets items={briefing.openPoints} empty="Keine offenen Punkte." />
            </Section>
            <Section title="Vorbereiten">
              <Bullets items={booking.needsPreparation && booking.preparationNote ? [booking.preparationNote, ...briefing.preparation.filter((p) => p !== booking.preparationNote)] : briefing.preparation} empty="Nichts Besonderes." />
            </Section>
          </div>
          <p className="text-xs text-fg-subtle">KI-Vorschlag{data.generatedAt ? `, erstellt ${formatZurich(data.generatedAt, 'dd.MM.yyyy HH:mm')}` : ''} – bitte kritisch lesen.</p>
        </div>
      )}

      <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
        <p className="flex items-center gap-1.5 text-xs text-fg-muted">
          {delivery.mode === 'mail' ? (
            <>
              <Mail className="size-3.5" aria-hidden />
              {delivery.mailSentAt
                ? `Per Mail verschickt am ${formatZurich(delivery.mailSentAt, 'dd.MM.yyyy')}`
                : delivery.mailDueAt
                  ? `Geht per Mail am ${formatZurich(delivery.mailDueAt, 'dd.MM.yyyy')} an Sales und Nico`
                  : 'Wird per Mail verschickt'}
            </>
          ) : (
            <>
              <CalendarClock className="size-3.5" aria-hidden />
              {delivery.calendarEntries > 0 ? 'Im Kalender von Sales und Nico eingetragen (als «frei»)' : 'Kalendereintrag folgt'}
            </>
          )}
        </p>
        <div className="flex items-center gap-2">
          {briefing && (
            <Button variant="ghost" icon={RefreshCw} onClick={() => regenerate.mutate()} loading={regenerate.isPending} disabled={cancelled}>
              Neu erstellen
            </Button>
          )}
          {data.canUpdateStatus && briefing && (
            <Button
              variant={booking.briefingStatus === 'prepared' ? 'secondary' : 'primary'}
              icon={CheckCircle2}
              onClick={() => status.mutate(booking.briefingStatus === 'prepared' ? 'open' : 'prepared')}
              loading={status.isPending}
              kbd={canPrepare ? 'P' : undefined}
            >
              {booking.briefingStatus === 'prepared' ? 'Vorbereitung wieder öffnen' : 'Vorbereitung erledigt'}
            </Button>
          )}
        </div>
      </footer>
    </Card>
  );
}
