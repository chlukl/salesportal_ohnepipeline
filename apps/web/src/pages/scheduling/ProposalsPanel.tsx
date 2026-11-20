/** «3 Vorschläge» (INTENT 6.6): month + time wish → 3 proposals (one per month third, never same week) → mail draft → send. */
import { formatLongDate, formatMonth, localHhmm, type DayHalf, type IsoDate, type Proposal } from '@sales-portal/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CalendarRange, RefreshCw, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/app/api';
import { useShortcut } from '@/app/shortcuts';
import { toast } from '@/app/toast';
import { Button, EmptyState, Input, Kbd, Skeleton, SkeletonText, Tabs, Textarea } from '@/components/ui';
import { schedulingKeys, useBookingContext, useProposalMonths, type BookingContext, type ProposalsResponse, type SendProposalsResponse } from './api';
import { ApprovalStep, AttendeeEditor, Notice, PanelShell, ParticipantsRow, SectionTitle, type AttendeeDraft } from './components';
import type { SchedulingPanelProps } from './types';

const THIRD_LABEL: Record<1 | 2 | 3, string> = { 1: 'Monatsanfang', 2: 'Monatsmitte', 3: 'Monatsende' };
const PREFERENCES: { id: DayHalf; label: string }[] = [
  { id: 'any', label: 'egal' },
  { id: 'morning', label: 'Vormittag' },
  { id: 'afternoon', label: 'Nachmittag' },
];

export function ProposalsPanel({ leadId, callSessionId, onClose, onDone, embedded = true }: SchedulingPanelProps) {
  const ctx = useBookingContext(leadId);
  const months = useProposalMonths();
  return (
    <PanelShell
      title="3 Terminvorschläge"
      description={ctx.data ? `${ctx.data.lead.companyname}${ctx.data.lead.fullname ? ` · ${ctx.data.lead.fullname}` : ''}` : 'Vorschläge per Mail senden'}
      onClose={onClose}
      embedded={embedded}
      shortcutGroup="3 Vorschläge"
    >
      {ctx.isLoading || months.isLoading ? (
        <SkeletonText lines={8} />
      ) : ctx.isError || months.isError || !ctx.data || !months.data ? (
        <Notice tone="danger">Die Vorschläge konnten nicht geladen werden: {errorMessage(ctx.error ?? months.error)}</Notice>
      ) : (
        <ProposalsForm
          key={leadId}
          ctx={ctx.data}
          months={months.data.months}
          preselected={months.data.preselected}
          leadId={leadId}
          callSessionId={callSessionId ?? null}
          onDone={onDone}
          onClose={onClose}
        />
      )}
    </PanelShell>
  );
}

function ProposalsForm({
  ctx,
  months,
  preselected,
  leadId,
  callSessionId,
  onDone,
  onClose,
}: {
  ctx: BookingContext;
  months: IsoDate[];
  preselected: IsoDate;
  leadId: string;
  callSessionId: string | null;
  onDone: SchedulingPanelProps['onDone'];
  onClose?: () => void;
}) {
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(preselected);
  const [preference, setPreference] = useState<DayHalf>('any');
  const [extraCall, setExtraCall] = useState(false);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [to, setTo] = useState<AttendeeDraft[]>(() => (ctx.lead.email ? [{ email: ctx.lead.email, name: ctx.lead.fullname, isMainContact: false }] : []));
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [dirty, setDirty] = useState(false);
  const lastText = useRef<string>('');
  const [sent, setSent] = useState<SendProposalsResponse | null>(null);

  const query = useQuery({
    queryKey: schedulingKeys.proposals(leadId, month, preference, extraCall),
    queryFn: () => api.post<ProposalsResponse>('/api/scheduling/proposals', { leadId, month, preference, extraCall }),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  /** New proposals → swap the list inside the mail text (also when the text was edited). */
  const applyResult = (res: ProposalsResponse) => {
    setProposals(res.proposals);
    setSubject((s) => (dirty && s ? s : res.draft.subject));
    setBody((current) => {
      if (!dirty || !current) return res.draft.body;
      if (lastText.current && current.includes(lastText.current)) return current.replace(lastText.current, res.text);
      toast.warning('Mailtext bearbeitet', { description: 'Die neuen Vorschläge bitte von Hand in den Text übernehmen.' });
      return current;
    });
    lastText.current = res.text;
  };

  useEffect(() => {
    if (query.data) {
      applyResult(query.data);
      setExcluded([]);
    }
  }, [query.data]);

  const swap = useMutation({
    mutationFn: (index: number) =>
      api.post<ProposalsResponse>('/api/scheduling/proposals/swap', {
        leadId,
        month,
        preference,
        extraCall,
        current: proposals.map((p) => ({ start: p.slot.start, end: p.slot.end })),
        index,
        excludeStarts: [...excluded, proposals[index].slot.start],
      }),
    onSuccess: (res, index) => {
      setExcluded((e) => [...e, proposals[index].slot.start]);
      applyResult(res);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const send = useMutation({
    mutationFn: () =>
      api.post<SendProposalsResponse>('/api/scheduling/proposals/send', {
        leadId,
        callSessionId,
        to: to.map((a) => a.email),
        subject,
        body,
      }),
    onSuccess: (res) => {
      setSent(res);
      toast.success('Vorschläge gesendet', {
        description: res.withCallResult ? 'Anrufstatus und Nachfass-Aufgabe gibst du mit dem Anrufergebnis frei.' : 'Jetzt die CRM-Änderungen freigeben.',
      });
      void queryClient.invalidateQueries({ queryKey: ['workspace', leadId] });
      onDone?.({ kind: 'proposals_sent', changeSetId: res.changeSetId, withCallResult: res.withCallResult });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const canSend = proposals.length > 0 && to.length > 0 && subject.trim().length > 0 && body.trim().length > 0 && !send.isPending && !sent;
  useShortcut('mod+enter', () => canSend && send.mutate(), { description: 'Vorschläge senden', group: '3 Vorschläge', allowInInput: true, enabled: !sent });
  useShortcut('1', () => proposals[0] && swap.mutate(0), { description: 'Anderer 1. Vorschlag', group: '3 Vorschläge', enabled: !sent && proposals.length > 0 });
  useShortcut('2', () => proposals[1] && swap.mutate(1), { description: 'Anderer 2. Vorschlag', group: '3 Vorschläge', enabled: !sent && proposals.length > 1 });
  useShortcut('3', () => proposals[2] && swap.mutate(2), { description: 'Anderer 3. Vorschlag', group: '3 Vorschläge', enabled: !sent && proposals.length > 2 });
  useShortcut('z', () => setExtraCall((v) => !v), { description: 'Zusatzcall ein/aus', group: '3 Vorschläge', enabled: !sent });

  if (sent) {
    return (
      <ApprovalStep
        title="Vorschläge gesendet"
        changeSetId={sent.changeSetId}
        lines={[
          `An ${to.map((a) => a.email).join(', ')}${sent.redirected ? ` (Testmodus: zugestellt an ${sent.deliveredTo.join(', ')})` : ''}`,
          'Bestätigt der Kunde, im Terminplaner buchen → «Termin gebucht».',
          sent.taskNote ?? 'Nachfass-Aufgabe in 3 Arbeitstagen ist vorbereitet.',
        ]}
        {...(sent.withCallResult
          ? {
              previewTitle: 'Mail im CRM',
              previewHint: 'nur die gesendete Mail, ohne Lead-Felder',
              action: onClose ? (
                <Button variant="primary" size="sm" iconRight={ArrowRight} onClick={onClose}>
                  Weiter zum Ergebnis
                </Button>
              ) : undefined,
            }
          : {})}
      />
    );
  }

  const res = query.data;
  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div>
          <SectionTitle>Monat</SectionTitle>
          <Tabs variant="pill" label="Monat" value={month} onChange={setMonth} items={months.map((m) => ({ id: m, label: formatMonth(m).replace(/ \d{4}$/, '') }))} />
        </div>
        <div>
          <SectionTitle>Zeitwunsch</SectionTitle>
          <Tabs variant="pill" label="Zeitwunsch" value={preference} onChange={setPreference} items={PREFERENCES} />
        </div>
      </div>

      <ParticipantsRow standard={ctx.participants.standard} extra={ctx.participants.extraCall} extraCall={extraCall} onExtraCall={setExtraCall} />

      <div>
        <SectionTitle hint="je Monatsdrittel einer, nie zwei in derselben Woche">Vorschläge {formatMonth(month)}</SectionTitle>
        {query.isLoading || query.isFetching ? (
          <div className="space-y-2" aria-busy>
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : query.isError ? (
          <Notice tone="danger">{errorMessage(query.error)}</Notice>
        ) : proposals.length === 0 ? (
          <EmptyState
            compact
            icon={CalendarRange}
            title="In diesem Monat ist nichts frei"
            description={res?.unavailableCalendars.length ? `Kalender nicht lesbar: ${res.unavailableCalendars.join(', ')}` : 'Anderen Monat wählen, den Zeitwunsch auf «egal» stellen oder den Zusatzcall ausschalten.'}
          />
        ) : (
          <>
            <ol className="space-y-2">
              {proposals.map((p, i) => (
                <li key={p.slot.start} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-[13px] font-semibold text-primary">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">{formatLongDate(p.slot.start).replace(/ \d{4}$/, '')}</p>
                    <p className="text-[13px] text-fg-muted">
                      {localHhmm(p.slot.start)}–{localHhmm(p.slot.end)} Uhr · {THIRD_LABEL[p.monthThird]}
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" icon={RefreshCw} loading={swap.isPending && swap.variables === i} onClick={() => swap.mutate(i)} aria-label={`Anderer Vorschlag statt Nummer ${i + 1}`}>
                    anderer <Kbd>{i + 1}</Kbd>
                  </Button>
                </li>
              ))}
            </ol>
            {proposals.length < 3 && (
              <p className="mt-2 text-xs text-fg-muted">Nur {proposals.length} Vorschläge möglich – nie zwei in derselben Woche. Für mehr einen anderen Monat wählen.</p>
            )}
          </>
        )}
      </div>

      <div className="space-y-3">
        <AttendeeEditor label="An" attendees={to} onChange={setTo} leadDomain={ctx.lead.domain} internalDomains={ctx.internalDomains} allowMainContact={false} />
        <Input
          label="Betreff"
          value={subject}
          maxLength={255}
          onChange={(e) => {
            setSubject(e.target.value);
            setDirty(true);
          }}
        />
        <Textarea
          label="Mailtext"
          rows={12}
          value={body}
          maxLength={20_000}
          onChange={(e) => {
            setBody(e.target.value);
            setDirty(true);
          }}
          hint={
            dirty && res ? (
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => {
                  setDirty(false);
                  setBody(res.draft.body.replace(res.text, lastText.current));
                }}
              >
                Text neu aus der Vorlage erzeugen
              </button>
            ) : (
              'Vorlage aus dem Admin – vor dem Senden anpassbar. Die Mail geht aus deinem Postfach.'
            )
          }
        />
      </div>

      <div className="sticky bottom-0 -mx-4 -mb-4 border-t border-border bg-surface px-4 py-3">
        <Button variant="primary" size="lg" className="w-full" icon={Send} kbd="Ctrl ↵" disabled={!canSend} loading={send.isPending} onClick={() => send.mutate()}>
          Vorschläge senden
        </Button>
        <p className="mt-1.5 text-center text-[11px] text-fg-subtle">
          {callSessionId
            ? 'Danach: Anrufstatus «Termin vorgeschlagen» und Nachfass-Aufgabe mit dem Anrufergebnis freigeben.'
            : 'Danach: Anrufstatus «Termin vorgeschlagen» und Nachfass-Aufgabe zur Freigabe.'}
        </p>
      </div>
    </div>
  );
}
