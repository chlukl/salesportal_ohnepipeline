/** Terminplaner (INTENT 6.6): week view of free slots, Zusatzcall, attendees, subject/text, «Termin buchen». */
import {
  addDaysIso,
  CANCELLATION_CALL_STATUSES,
  fillTemplate,
  formatLongDate,
  localHhmm,
  mondayOfIso,
  optionLabel,
  weekdayOfIso,
  type Booking,
  type Slot,
} from '@sales-portal/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CalendarCheck, CalendarClock, CalendarX, ExternalLink, FlaskConical, MoreHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, errorMessage } from '@/app/api';
import { useAuth } from '@/app/auth';
import { useShortcut } from '@/app/shortcuts';
import { toast } from '@/app/toast';
import { Badge, Button, Checkbox, Dialog, DropdownMenu, IconButton, Input, Select, SkeletonText, Textarea } from '@/components/ui';
import { schedulingKeys, useBookingContext, useWeekSlots, type BookingContext, type BookingResponse } from './api';
import {
  ApprovalStep,
  AttendeeEditor,
  BOOKING_STATUS,
  bookingWhen,
  EmptyWeek,
  Notice,
  PanelShell,
  ParticipantsRow,
  SectionTitle,
  todayIsoZurich,
  useBlockPanelEscape,
  WeekNav,
  WeekSlots,
  type AttendeeDraft,
} from './components';
import type { SchedulingPanelProps, SchedulingResult } from './types';

function initialWeek(today: string): string {
  const wd = weekdayOfIso(today);
  // Friday afternoon / weekend → start with next week.
  return wd === 0 || wd === 6 || wd === 5 ? mondayOfIso(addDaysIso(today, 3)) : mondayOfIso(today);
}

export function SchedulingPanel({ leadId, callSessionId, onClose, onDone, embedded = true }: SchedulingPanelProps) {
  const ctx = useBookingContext(leadId);
  return (
    <PanelShell
      title="Termin buchen"
      description={ctx.data ? `${ctx.data.lead.companyname}${ctx.data.lead.fullname ? ` · ${ctx.data.lead.fullname}` : ''}` : 'Erstgespräch über Teams, 30 Minuten'}
      onClose={onClose}
      embedded={embedded}
    >
      {ctx.isLoading ? (
        <SkeletonText lines={8} />
      ) : ctx.isError || !ctx.data ? (
        <Notice tone="danger">Der Terminplaner konnte nicht geladen werden: {errorMessage(ctx.error)}</Notice>
      ) : (
        <BookingForm key={leadId} ctx={ctx.data} leadId={leadId} callSessionId={callSessionId ?? null} onDone={onDone} onClose={onClose} />
      )}
    </PanelShell>
  );
}

function BookingForm({
  ctx,
  leadId,
  callSessionId,
  onDone,
  onClose,
}: {
  ctx: BookingContext;
  leadId: string;
  callSessionId: string | null;
  onDone?: (result: SchedulingResult) => void;
  onClose?: () => void;
}) {
  const queryClient = useQueryClient();
  const today = todayIsoZurich();
  const [weekStart, setWeekStart] = useState(() => initialWeek(today));
  const [extraCall, setExtraCall] = useState(false);
  const [selected, setSelected] = useState<Slot | null>(null);
  const [attendees, setAttendees] = useState<AttendeeDraft[]>(() =>
    ctx.lead.email ? [{ email: ctx.lead.email, name: ctx.lead.fullname, isMainContact: true }] : [],
  );
  const [subject, setSubject] = useState(ctx.subject);
  const [body, setBody] = useState('');
  const [bodyDirty, setBodyDirty] = useState(false);
  const [needsPreparation, setNeedsPreparation] = useState(false);
  const [preparationNote, setPreparationNote] = useState('');
  const [decisionMaker, setDecisionMaker] = useState(false);
  const [result, setResult] = useState<BookingResponse | null>(null);
  const inCall = !!callSessionId;
  const slotsQuery = useWeekSlots(weekStart, extraCall);
  const participants = extraCall ? ctx.participants.extraCall : ctx.participants.standard;

  const activeBookings = ctx.bookings.filter((b) => b.status === 'booked' || b.status === 'rescheduled');
  const otherBookings = ctx.bookings.filter((b) => !activeBookings.includes(b));

  // Invitation text follows the chosen slot until the user edits it.
  const filledBody = useMemo(() => {
    if (!selected) return fillTemplate(ctx.invitationTemplate, { Sales: participants.sales.displayName, Spezialist: participants.specialist.displayName });
    return fillTemplate(ctx.invitationTemplate, {
      Datum: formatLongDate(selected.start),
      Uhrzeit: localHhmm(selected.start),
      Sales: participants.sales.displayName,
      Spezialist: participants.specialist.displayName,
    });
  }, [ctx.invitationTemplate, selected, participants]);
  useEffect(() => {
    if (!bodyDirty) setBody(filledBody);
  }, [filledBody, bodyDirty]);

  const toggleExtra = (v: boolean) => {
    setExtraCall(v);
    setSelected(null);
  };

  const book = useMutation({
    mutationFn: () =>
      api.post<BookingResponse>('/api/scheduling/bookings', {
        leadId,
        callSessionId,
        start: selected!.start,
        extraCall,
        subject,
        body,
        attendees,
        needsPreparation,
        preparationNote: needsPreparation ? preparationNote : null,
        // During a call «Entscheider» is part of the call result «Termin gebucht».
        decisionMakerInMeeting: inCall ? undefined : decisionMaker,
      }),
    onSuccess: (res) => {
      setResult(res);
      toast.success('Termin gebucht', {
        description: res.withCallResult
          ? 'Einladung ist verschickt, Blocker sind gesetzt. Anrufstatus und Felder gibst du mit dem Anrufergebnis frei.'
          : 'Einladung ist verschickt, Blocker sind gesetzt. Jetzt die CRM-Änderungen freigeben.',
      });
      void queryClient.invalidateQueries({ queryKey: ['scheduling'] });
      void queryClient.invalidateQueries({ queryKey: ['workspace', leadId] });
      onDone?.({ kind: 'booked', bookingId: res.booking.id, changeSetId: res.changeSetId, withCallResult: res.withCallResult });
    },
    onError: (err) => {
      if (err instanceof ApiError && (err.code === 'slot_taken' || err.code === 'extra_call_not_allowed')) {
        setSelected(null);
        void queryClient.invalidateQueries({ queryKey: ['scheduling', 'slots'] });
      }
      toast.error(errorMessage(err));
    },
  });

  const canBook = !!selected && attendees.length > 0 && subject.trim().length > 0 && !book.isPending && !result;
  const missing = !selected ? 'Zuerst eine freie Zeit wählen' : attendees.length === 0 ? 'Mindestens eine externe Person einladen' : null;

  useShortcut('mod+enter', () => canBook && book.mutate(), { description: 'Termin buchen', group: 'Terminplaner', allowInInput: true, enabled: !result });
  useShortcut('shift+arrowright', () => setWeekStart((w) => addDaysIso(w, 7)), { description: 'Nächste Woche', group: 'Terminplaner', enabled: !result });
  useShortcut('shift+arrowleft', () => setWeekStart((w) => (w > mondayOfIso(today) ? addDaysIso(w, -7) : w)), {
    description: 'Vorherige Woche',
    group: 'Terminplaner',
    enabled: !result,
  });
  useShortcut('z', () => toggleExtra(!extraCall), { description: 'Zusatzcall ein/aus', group: 'Terminplaner', enabled: !result });

  if (result) {
    const b = result.booking;
    const lines = [
      `${formatLongDate(b.start)}, ${localHhmm(b.start)}–${localHhmm(b.end)} Uhr`,
      `Teams-Einladung an ${b.externalAttendees.map((a) => a.email).join(', ')}`,
      result.blockersPending ? 'Blocker werden im Hintergrund gesetzt.' : 'Blocker 30 Min. davor und danach sind gesetzt.',
      b.needsPreparation ? 'Vorbereitung nötig: Briefing-Mail geht 1 Woche vorher an Sales und Nico.' : 'Briefing kommt als Eintrag in den Kalender von Sales und Nico.',
    ];
    if (result.withCallResult) {
      // During a call: fields + call status are approved once, with the call result «Termin gebucht».
      return (
        <ApprovalStep
          title="Termin gebucht"
          changeSetId={result.changeSetId}
          lines={[...lines, 'Anrufstatus, Bewertung und Entscheider gibst du mit dem Anrufergebnis «Termin gebucht» frei.']}
          previewTitle="Termin im CRM"
          previewHint="nur der Termin, ohne Lead-Felder"
          action={
            onClose ? (
              <Button variant="primary" size="sm" iconRight={ArrowRight} onClick={onClose}>
                Weiter zum Ergebnis
              </Button>
            ) : undefined
          }
        />
      );
    }
    return <ApprovalStep title="Termin gebucht" changeSetId={result.changeSetId} lines={lines} />;
  }

  const slots = slotsQuery.data?.from === weekStart ? slotsQuery.data.slots : [];
  return (
    <div className="space-y-5">
      {(activeBookings.length > 0 || otherBookings.length > 0) && (
        <ExistingBookings ctx={ctx} active={activeBookings} other={otherBookings} selected={selected} leadId={leadId} />
      )}

      <ParticipantsRow standard={ctx.participants.standard} extra={ctx.participants.extraCall} extraCall={extraCall} onExtraCall={toggleExtra} />

      <div>
        <SectionTitle hint="mit 30 Min. Puffer davor und danach">Freie Zeiten</SectionTitle>
        <WeekNav weekStart={weekStart} onChange={setWeekStart} todayIso={today} />
        <div className="mt-3">
          {!slotsQuery.isLoading && slots.length === 0 && !slotsQuery.isFetching ? (
            <EmptyWeek extraCall={extraCall} onNext={() => setWeekStart(addDaysIso(weekStart, 7))} unavailable={slotsQuery.data?.unavailableCalendars ?? []} />
          ) : slotsQuery.isError ? (
            <Notice tone="danger">Kalender konnten nicht gelesen werden: {errorMessage(slotsQuery.error)}</Notice>
          ) : (
            <WeekSlots
              weekStart={weekStart}
              slots={slots}
              loading={slotsQuery.isLoading || (slotsQuery.isFetching && slots.length === 0)}
              selected={selected?.start ?? null}
              onSelect={setSelected}
              todayIso={today}
            />
          )}
        </div>
      </div>

      {selected && (
        <div className="rounded-lg border border-primary/40 bg-primary-subtle px-4 py-3" aria-live="polite">
          <p className="text-[15px] font-semibold text-fg">
            {formatLongDate(selected.start)}, {localHhmm(selected.start)}–{localHhmm(selected.end)} Uhr
          </p>
          <p className="mt-0.5 text-[13px] text-fg-muted">
            Teams-Meeting · Organisator {participants.sales.displayName} · mit {participants.specialist.displayName}
          </p>
        </div>
      )}

      <AttendeeEditor attendees={attendees} onChange={setAttendees} leadDomain={ctx.lead.domain} internalDomains={ctx.internalDomains} />

      <div className="space-y-3">
        <SectionTitle>Einladung</SectionTitle>
        <Input label="Betreff" value={subject} maxLength={255} onChange={(e) => setSubject(e.target.value)} />
        <Textarea
          label="Text"
          rows={8}
          value={body}
          maxLength={20_000}
          onChange={(e) => {
            setBody(e.target.value);
            setBodyDirty(true);
          }}
          hint={
            bodyDirty && selected ? (
              <button type="button" className="text-primary hover:underline" onClick={() => setBodyDirty(false)}>
                Text neu aus der Vorlage erzeugen (Datum prüfen)
              </button>
            ) : (
              'Vorlage aus dem Admin – vor dem Buchen anpassbar.'
            )
          }
        />
      </div>

      <div className="space-y-3">
        <SectionTitle>Für das Briefing</SectionTitle>
        {inCall ? (
          <p className="text-[13px] text-fg-muted">«Entscheider ist dabei» kreuzt du nach dem Buchen im Ergebnis «Termin gebucht» an.</p>
        ) : (
          <Checkbox
            checked={decisionMaker}
            onChange={(e) => setDecisionMaker(e.target.checked)}
            label="Entscheider ist im Termin dabei"
            description="setzt «Entscheider = Ja» am Lead (nach deiner Freigabe)"
          />
        )}
        <Checkbox
          checked={needsPreparation}
          onChange={(e) => setNeedsPreparation(e.target.checked)}
          label="Vorbereitung nötig"
          description="z. B. Demo, Prototyp, Unterlagen – Briefing-Mail 1 Woche vorher an Sales und Nico"
        />
        {needsPreparation && (
          <Textarea rows={2} placeholder="Was soll vorbereitet werden?" aria-label="Was soll vorbereitet werden?" maxLength={2000} value={preparationNote} onChange={(e) => setPreparationNote(e.target.value)} />
        )}
      </div>

      <div className="sticky bottom-0 -mx-4 -mb-4 border-t border-border bg-surface px-4 py-3">
        {missing && <p className="mb-2 text-xs text-fg-subtle">{missing}</p>}
        <Button variant="primary" size="lg" className="w-full" icon={CalendarCheck} kbd="Ctrl ↵" disabled={!canBook} loading={book.isPending} onClick={() => book.mutate()}>
          Termin buchen
        </Button>
        <p className="mt-1.5 text-center text-[11px] text-fg-subtle">Prüft die Kalender direkt vor dem Buchen nochmals – sonst «belegt».</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Existing bookings of the lead: move to the chosen slot, cancel, call status after a cancellation, demo simulation
// ---------------------------------------------------------------------------------------------------------------------

function ExistingBookings({ ctx, active, other, selected, leadId }: { ctx: BookingContext; active: Booking[]; other: Booking[]; selected: Slot | null; leadId: string }) {
  return (
    <div>
      <SectionTitle>Termine dieses Leads</SectionTitle>
      <ul className="space-y-2">
        {[...active, ...other.slice(0, 3)].map((b) => (
          <BookingRow key={b.id} booking={b} ctx={ctx} selected={selected} leadId={leadId} />
        ))}
      </ul>
    </div>
  );
}

function BookingRow({ booking, ctx, selected, leadId }: { booking: Booking; ctx: BookingContext; selected: Slot | null; leadId: string }) {
  const { hasRole } = useAuth();
  const queryClient = useQueryClient();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [callStatus, setCallStatus] = useState(String(CANCELLATION_CALL_STATUSES[2]));
  const [changeSetId, setChangeSetId] = useState<string | null>(null);
  useBlockPanelEscape(confirmCancel);
  const status = BOOKING_STATUS[booking.status];
  const active = booking.status === 'booked' || booking.status === 'rescheduled';
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['scheduling'] });
    void queryClient.invalidateQueries({ queryKey: ['workspace', leadId] });
  };

  const move = useMutation({
    mutationFn: () => api.post<Booking>(`/api/scheduling/bookings/${booking.id}/move`, { start: selected!.start }),
    onSuccess: () => {
      toast.success('Termin verschoben', { description: 'Einladung, Blocker und Briefing-Eintrag sind angepasst.' });
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const cancel = useMutation({
    mutationFn: () => api.post<Booking>(`/api/scheduling/bookings/${booking.id}/cancel`),
    onSuccess: () => {
      setConfirmCancel(false);
      toast.success('Termin abgesagt', { description: 'Absage ist verschickt, Blocker sind entfernt. Jetzt den Anrufstatus setzen.' });
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const setStatus = useMutation({
    mutationFn: () => api.post<{ changeSetId: string }>(`/api/scheduling/bookings/${booking.id}/callstatus`, { callStatus: Number(callStatus) }),
    onSuccess: (res) => setChangeSetId(res.changeSetId),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const simulate = useMutation({
    mutationFn: (action: string) => api.post(`/api/scheduling/bookings/${booking.id}/simulate`, { action }),
    onSuccess: () => {
      toast.info('Demo: Änderung simuliert und erkannt');
      refresh();
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const demo = ctx.calendarMode === 'mock' && hasRole('admin') && active;
  return (
    <li className="rounded-md border border-border px-3 py-2.5">
      <div className="flex items-center gap-2">
        <CalendarClock className="size-4 shrink-0 text-fg-subtle" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{bookingWhen(booking)}</span>
        <Badge tone={status.tone} dot>
          {status.label}
        </Badge>
        {booking.origin === 'campaign' && <Badge tone="info">aus Kampagne</Badge>}
        {demo && (
          <DropdownMenu
            width={240}
            trigger={({ toggle }) => <IconButton icon={MoreHorizontal} label="Demo-Aktionen" size="sm" onClick={toggle} />}
            sections={[
              {
                key: 'demo',
                title: 'Demo: so reagiert das Portal',
                items: [
                  { key: 'cancel', label: 'Sales sagt in Outlook ab', icon: FlaskConical, onSelect: () => simulate.mutate('cancel') },
                  { key: 'decline_main', label: 'Kunde lehnt ab', icon: FlaskConical, onSelect: () => simulate.mutate('decline_main') },
                  { key: 'decline_other', label: 'Weitere Person lehnt ab', icon: FlaskConical, onSelect: () => simulate.mutate('decline_other') },
                  { key: 'decline_specialist', label: 'Nico lehnt ab', icon: FlaskConical, onSelect: () => simulate.mutate('decline_specialist') },
                  { key: 'move', label: 'In Outlook um 1 Tag verschoben', icon: FlaskConical, onSelect: () => simulate.mutate('move') },
                ],
              },
            ]}
          />
        )}
      </div>
      {active && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" icon={CalendarClock} disabled={!selected || move.isPending} loading={move.isPending} onClick={() => move.mutate()}>
            {selected ? `Auf ${localHhmm(selected.start)} am ${formatLongDate(selected.start).split(',')[0]} verschieben` : 'Zum Verschieben Zeit wählen'}
          </Button>
          <Button size="sm" variant="ghost" icon={CalendarX} onClick={() => setConfirmCancel(true)}>
            Absagen
          </Button>
        </div>
      )}
      {booking.status === 'cancelled' && !changeSetId && (
        <div className="mt-2 flex items-end gap-2">
          <Select
            className="min-w-0 flex-1"
            selectSize="sm"
            label="Neuer Anrufstatus"
            value={callStatus}
            onChange={(e) => setCallStatus(e.target.value)}
            options={CANCELLATION_CALL_STATUSES.map((c) => ({ value: String(c), label: optionLabel('kls_callstatus', c) ?? String(c) }))}
          />
          <Button size="sm" loading={setStatus.isPending} onClick={() => setStatus.mutate()}>
            Vorschau
          </Button>
        </div>
      )}
      {changeSetId && (
        <div className="mt-3">
          <ApprovalStep title="Anrufstatus vorbereitet" lines={['Wird erst nach deiner Freigabe ins CRM geschrieben.']} changeSetId={changeSetId} />
        </div>
      )}
      <Dialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Termin absagen?"
        description={`${bookingWhen(booking)} – alle Eingeladenen bekommen eine Absage, Blocker und Briefing-Eintrag werden entfernt.`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmCancel(false)}>
              Behalten
            </Button>
            <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>
              Absagen
            </Button>
          </>
        }
      />
      {booking.status === 'cancelled' && (
        <p className="mt-1.5 flex items-center gap-1 text-xs text-fg-subtle">
          <ExternalLink className="size-3" aria-hidden /> Neu planen: oben eine Zeit wählen und neu buchen.
        </p>
      )}
    </li>
  );
}
