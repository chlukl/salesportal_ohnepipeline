/** Terminregeln, Einstellungen und Verbindungen/Zugänge (Ablaufdaten der Geheimnisse, Umgebung). */
import type { AdminConnections, AdminSettings, BookingRules, SecretExpiry } from '@sales-portal/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Save, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api, errorMessage } from '@/app/api';
import { toast } from '@/app/toast';
import { Badge, Button, Card, CardBody, CardHeader, IconButton, Input, SkeletonText, Table, TBody, TD, TH, THead, TR, type BadgeTone } from '@/components/ui';
import { useSaveShortcut } from './common';

const num = (v: string) => (v === '' ? 0 : Number(v));

// =====================================================================================================================
// Terminregeln
// =====================================================================================================================

export function BookingRulesTab() {
  const rules = useQuery({ queryKey: ['admin', 'booking-rules'], queryFn: () => api.get<BookingRules>('/api/admin/booking-rules') });
  if (rules.isLoading || !rules.data) return <SkeletonText lines={8} />;
  return <BookingRulesForm key={JSON.stringify(rules.data)} initial={rules.data} />;
}

function WindowList({ label, value, onChange }: { label: string; value: { from: string; to: string }[]; onChange: (v: { from: string; to: string }[]) => void }) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-[13px] font-medium text-fg">{label}</legend>
      {value.map((w, i) => (
        <div key={i} className="flex items-end gap-2">
          <Input inputSize="sm" type="time" aria-label="von" value={w.from} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
          <span className="pb-1.5 text-sm text-fg-subtle">bis</span>
          <Input inputSize="sm" type="time" aria-label="bis" value={w.to} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
          <IconButton icon={Trash2} size="sm" label="Zeitfenster entfernen" onClick={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Button size="sm" variant="ghost" icon={Plus} onClick={() => onChange([...value, { from: '09:00', to: '10:00' }])}>
        Zeitfenster
      </Button>
    </fieldset>
  );
}

function BookingRulesForm({ initial }: { initial: BookingRules }) {
  const qc = useQueryClient();
  const [r, setR] = useState<BookingRules>(initial);
  const set = <K extends keyof BookingRules>(k: K, v: BookingRules[K]) => setR((x) => ({ ...x, [k]: v }));
  const dirty = JSON.stringify(r) !== JSON.stringify(initial);
  const save = useMutation({
    mutationFn: () => api.put<BookingRules>('/api/admin/booking-rules', r),
    onSuccess: () => {
      toast.success('Terminregeln gespeichert', { description: 'Gilt ab der nächsten Slot-Suche.' });
      void qc.invalidateQueries({ queryKey: ['admin', 'booking-rules'] });
    },
    onError: (err) => toast.error('Nicht gespeichert', { description: errorMessage(err), duration: 10_000 }),
  });
  useSaveShortcut(() => dirty && !save.isPending && save.mutate(), true, 'Terminregeln speichern');
  return (
    <Card>
      <CardHeader
        title="Terminregeln"
        description="Zeiten und Puffer für Erstgespräche (INTENT: 30 Min. Puffer davor und danach, für alle und zu jeder Startzeit)."
        actions={
          <Button variant="primary" icon={Save} kbd="Ctrl S" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
            Speichern
          </Button>
        }
      />
      <CardBody className="grid grid-cols-3 gap-6">
        <WindowList label="Startzeiten (Termin beginnt in diesem Fenster)" value={r.startWindows} onChange={(v) => set('startWindows', v)} />
        <WindowList label="Keine Termine (z. B. Mittag)" value={r.blockedWindows} onChange={(v) => set('blockedWindows', v)} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Dauer (Min.)" type="number" min={15} value={r.durationMinutes} onChange={(e) => set('durationMinutes', num(e.target.value))} />
          <Input label="Raster (Min.)" type="number" min={5} value={r.slotStepMinutes} onChange={(e) => set('slotStepMinutes', num(e.target.value))} />
          <Input label="Puffer davor (Min.)" type="number" min={0} value={r.bufferBeforeMinutes} onChange={(e) => set('bufferBeforeMinutes', num(e.target.value))} />
          <Input label="Puffer danach (Min.)" type="number" min={0} value={r.bufferAfterMinutes} onChange={(e) => set('bufferAfterMinutes', num(e.target.value))} />
        </div>
        <Input label="Sales (Standard)" type="email" value={r.defaultSalesEmail} onChange={(e) => set('defaultSalesEmail', e.target.value)} />
        <Input label="AI-Spezialist" type="email" value={r.specialistEmail} onChange={(e) => set('specialistEmail', e.target.value)} />
        <Input label="Sales bei «Zusatzcall»" type="email" value={r.extraCallSalesEmail} onChange={(e) => set('extraCallSalesEmail', e.target.value)} />
        <Input className="col-span-2" label="Betreff der Einladung" hint="Platzhalter: {Firma}" value={r.subjectTemplate} onChange={(e) => set('subjectTemplate', e.target.value)} />
        <Input label="Briefing-Mail Tage vorher" hint="nur wenn etwas vorzubereiten ist" type="number" min={0} value={r.briefingMailDaysBefore} onChange={(e) => set('briefingMailDaysBefore', num(e.target.value))} />
        <Input label="Outlook-Kategorie Termin" value={r.outlookCategory} onChange={(e) => set('outlookCategory', e.target.value)} />
        <Input label="Outlook-Kategorie Briefing" value={r.briefingCategory} onChange={(e) => set('briefingCategory', e.target.value)} />
        <Input label="Zeitzone" value={r.timezone} disabled hint="fest: Europe/Zurich" />
      </CardBody>
    </Card>
  );
}

// =====================================================================================================================
// Einstellungen
// =====================================================================================================================

export function SettingsTab() {
  const s = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api.get<AdminSettings>('/api/admin/settings') });
  if (s.isLoading || !s.data) return <SkeletonText lines={8} />;
  return <SettingsForm key={JSON.stringify(s.data)} initial={s.data} />;
}

function SettingsForm({ initial }: { initial: AdminSettings }) {
  const qc = useQueryClient();
  const [v, setV] = useState<AdminSettings>(initial);
  const set = <K extends keyof AdminSettings>(k: K, val: AdminSettings[K]) => setV((x) => ({ ...x, [k]: val }));
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  const save = useMutation({
    mutationFn: () => {
      const patch = Object.fromEntries(Object.entries(v).filter(([k, val]) => JSON.stringify(val) !== JSON.stringify(initial[k as keyof AdminSettings])));
      return api.put<AdminSettings>('/api/admin/settings', patch);
    },
    onSuccess: () => {
      toast.success('Einstellungen gespeichert');
      void qc.invalidateQueries({ queryKey: ['admin', 'settings'] });
    },
    onError: (err) => toast.error('Nicht gespeichert', { description: errorMessage(err), duration: 10_000 }),
  });
  useSaveShortcut(() => dirty && !save.isPending && save.mutate(), true, 'Einstellungen speichern');
  return (
    <Card>
      <CardHeader
        title="Einstellungen"
        description="Fristen, Kostendeckel und Wochenreport. Jede Änderung steht im Protokoll."
        actions={
          <Button variant="primary" icon={Save} kbd="Ctrl S" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
            Speichern
          </Button>
        }
      />
      <CardBody className="space-y-8">
        <Group title="KI und Transkripte">
          <Input label="Transkripte löschen nach (Tagen)" hint="Transkripte liegen nur im Portal, ins CRM kommt nur die Analyse." type="number" min={1} max={365} value={v.transcriptRetentionDays} onChange={(e) => set('transcriptRetentionDays', num(e.target.value))} />
          <Input label="Analyse entfällt nach (Minuten ohne Transkript)" type="number" min={5} max={240} value={v.analysisTimeoutMinutes} onChange={(e) => set('analysisTimeoutMinutes', num(e.target.value))} />
          <Input label="KI-Kostendeckel pro Monat (USD)" hint="Darüber werden keine neuen Analysen gestartet." type="number" min={0} step={10} value={v.aiMonthlyBudgetUsd} onChange={(e) => set('aiMonthlyBudgetUsd', num(e.target.value))} />
        </Group>
        <Group title="Anrufe und Aufgaben">
          <Input label="Mail vorschlagen ab … «Nicht erreicht»" type="number" min={1} max={10} value={v.notReachedMailThreshold.attempts} onChange={(e) => set('notReachedMailThreshold', { ...v.notReachedMailThreshold, attempts: num(e.target.value) })} />
          <Input label="… innerhalb von (Tagen)" type="number" min={1} max={90} value={v.notReachedMailThreshold.withinDays} onChange={(e) => set('notReachedMailThreshold', { ...v.notReachedMailThreshold, withinDays: num(e.target.value) })} />
          <Input label="Kampagnen-Sperre (Monate ohne Aktivität)" type="number" min={1} max={24} value={v.campaignLockMonths} onChange={(e) => set('campaignLockMonths', num(e.target.value))} />
          <Input label="Max. Aufgaben pro Person und Tag" type="number" min={1} max={20} value={v.tasksMaxPerPersonPerDay} onChange={(e) => set('tasksMaxPerPersonPerDay', num(e.target.value))} />
        </Group>
        <Group title="Wochenreport" description={<>Geht montags ab 07:00 für die Vorwoche. Vorschau im <Link className="text-primary hover:underline" to="/dashboard">Dashboard</Link>.</>}>
          <Input label="Empfänger" type="email" placeholder="z. B. sales@firma.ch – leer = kein Versand" value={v.weeklyReportRecipient ?? ''} onChange={(e) => set('weeklyReportRecipient', e.target.value.trim() || null)} />
          <Input label="Absender-Postfach (optional)" type="email" placeholder="leer = Empfänger-Postfach" value={v.weeklyReportSender ?? ''} onChange={(e) => set('weeklyReportSender', e.target.value.trim() || null)} />
        </Group>
      </CardBody>
    </Card>
  );
}

function Group({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {description && <p className="mt-0.5 text-[13px] text-fg-muted">{description}</p>}
      <div className="mt-3 grid grid-cols-3 gap-4">{children}</div>
    </section>
  );
}

// =====================================================================================================================
// Verbindungen / Zugänge
// =====================================================================================================================

const STATUS: Record<SecretExpiry['status'], { tone: BadgeTone; label: string }> = {
  ok: { tone: 'success', label: 'gültig' },
  warning: { tone: 'warning', label: 'läuft bald ab' },
  expired: { tone: 'danger', label: 'abgelaufen' },
  unknown: { tone: 'neutral', label: 'Datum fehlt' },
};

export function ConnectionsTab() {
  const conn = useQuery({ queryKey: ['admin', 'connections'], queryFn: () => api.get<AdminConnections>('/api/admin/connections') });
  if (conn.isLoading || !conn.data) return <SkeletonText lines={8} />;
  const c = conn.data;
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Umgebung" description="Steht auch immer oben in der Kopfleiste." />
        <CardBody className="flex flex-wrap items-center gap-3 text-sm">
          <Badge size="md" tone={c.environment === 'Prod' ? 'danger' : c.environment === 'Sandbox' ? 'warning' : 'info'}>
            {c.environment}
          </Badge>
          <span className="text-fg-muted">Anmeldung: {c.authMode === 'entra' ? 'Microsoft Entra ID' : 'Dev-Login (nur lokal)'}</span>
          <span className="text-fg-muted">· Anbindungen: {c.integrations === 'mock' ? 'alle simuliert (Demo)' : c.integrations === 'live' ? 'alle live' : 'gemischt'}</span>
          {c.mailTestRecipient && <span className="text-fg-muted">· Kunden-Mails gehen an die Testadresse</span>}
        </CardBody>
      </Card>
      <Card className="overflow-hidden">
        <CardHeader title="Anbindungen" description="Umschalten nur über die Server-Konfiguration (INTEGRATIONS, *_ADAPTER)." />
        <Table dense>
          <THead>
            <tr>
              <TH>System</TH>
              <TH>Modus</TH>
            </tr>
          </THead>
          <TBody>
            {c.adapters.map((a) => (
              <TR key={a.name}>
                <TD className="font-medium">{a.label}</TD>
                <TD>{a.mode === 'live' ? <Badge tone="success">live</Badge> : <Badge tone="warning">simuliert</Badge>}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      <Card className="overflow-hidden">
        <CardHeader
          title="Geheimnisse und Zertifikate"
          description="Ablaufdatum eintragen – das Portal warnt 30 Tage vorher. Die Werte selbst liegen nur als Docker-Secret auf dem Server."
        />
        <Table>
          <THead>
            <tr>
              <TH>Zugang</TH>
              <TH>eingerichtet</TH>
              <TH>läuft ab am</TH>
              <TH>Status</TH>
            </tr>
          </THead>
          <TBody>
            {c.secrets.map((s) => (
              <SecretRow key={s.name} secret={s} />
            ))}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}

function SecretRow({ secret }: { secret: SecretExpiry }) {
  const qc = useQueryClient();
  const [date, setDate] = useState(secret.expiresOn ?? '');
  const save = useMutation({
    mutationFn: () => api.put<AdminConnections>(`/api/admin/connections/secrets/${secret.name}`, { expiresOn: date || null }),
    onSuccess: (data) => {
      qc.setQueryData(['admin', 'connections'], data);
      toast.success('Ablaufdatum gespeichert');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const st = STATUS[secret.status];
  return (
    <TR>
      <TD className="font-medium">
        <span className="flex items-center gap-2">
          <KeyRound className="size-4 text-fg-subtle" aria-hidden />
          {secret.label}
        </span>
      </TD>
      <TD className="text-fg-muted">{secret.configured ? 'ja' : 'nein'}</TD>
      <TD>
        <div className="flex items-center gap-2">
          <Input inputSize="sm" type="date" aria-label={`Ablaufdatum ${secret.label}`} value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
          {date !== (secret.expiresOn ?? '') && (
            <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              Speichern
            </Button>
          )}
        </div>
      </TD>
      <TD>
        <Badge tone={st.tone} dot>
          {st.label}
          {secret.daysLeft != null && secret.status !== 'ok' && (secret.daysLeft >= 0 ? ` · noch ${secret.daysLeft} Tage` : ` · seit ${-secret.daysLeft} Tagen`)}
        </Badge>
      </TD>
    </TR>
  );
}
