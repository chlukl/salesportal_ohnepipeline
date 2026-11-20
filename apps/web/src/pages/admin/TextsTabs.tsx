/** Vorlagen (Betreff, Einladung, Mails, Briefing – reiner Text mit Platzhaltern) und Einwände. */
import type { ObjectionAnswer, Template, TemplateKind } from '@sales-portal/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquareQuote, Pencil, Plus, Save } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '@/app/api';
import { useShortcut } from '@/app/shortcuts';
import { toast } from '@/app/toast';
import { Badge, Button, Card, CardBody, CardHeader, cn, Dialog, EmptyState, Input, SkeletonText, Table, TBody, TD, TH, THead, Textarea, Toggle, TR } from '@/components/ui';
import { formatDateTime, useSaveShortcut } from './common';

type TemplateWithHelp = Template & { placeholders: { name: string; help: string }[] };

const KIND_LABELS: Record<TemplateKind, string> = {
  subject: 'Betreff',
  invitation: 'Einladung',
  proposals: 'Mail',
  mail: 'Mail',
  briefing: 'Briefing',
};

const SAMPLE: Record<string, string> = {
  Firma: 'Muster Metallbau AG',
  Anrede: 'Frau',
  Vorname: 'Anna',
  Nachname: 'Beispiel',
  Absender: 'Markus',
  Datum: '02.12.2026',
  Uhrzeit: '10:00',
  Sales: 'Manuel',
  Spezialist: 'Nico',
  Vorschlaege: '- Di, 01.12.2026, 10:00 Uhr\n- Do, 10.12.2026, 14:30 Uhr\n- Mo, 21.12.2026, 09:30 Uhr',
  UseCase: 'Belegerfassung',
  UseCases: '- Belege und Rechnungen automatisch erfassen',
  Einleitung: 'Sie haben erwähnt, dass die Erfassung der Lieferscheine viel Zeit kostet.',
  Einstieg: 'Viele Metallbauer sparen bei Offerten pro Woche mehrere Stunden.',
  Terminangebot: 'Passt Ihnen ein kurzes Gespräch nächste Woche?',
  Kampagne: '',
  Profil: 'Metallbau, 60 MA, Basel',
  Kontakt: 'Anna Beispiel, Geschäftsleitung',
  Verlauf: 'Coldcall am 20.11.: Interesse an Belegerfassung.',
  Fragen: 'Wie läuft die Belegerfassung heute?',
  OffenePunkte: 'ERP-System unklar',
  Vorbereitung: 'kurze Demo Belegerfassung',
};

const fill = (text: string) => text.replace(/\{([^{}\n]*)\}/g, (m, name: string) => SAMPLE[name] ?? m);

export function TemplatesTab() {
  const templates = useQuery({ queryKey: ['admin', 'templates'], queryFn: () => api.get<{ items: TemplateWithHelp[] }>('/api/admin/templates') });
  const [selected, setSelected] = useState<string | null>(null);
  if (templates.isLoading) return <SkeletonText lines={8} />;
  const items = templates.data?.items ?? [];
  if (!items.length) return <EmptyState title="Keine Vorlagen" description="Die Standardvorlagen werden beim Start angelegt." />;
  const current = items.find((t) => t.id === selected) ?? items[0];
  return (
    <div className="grid grid-cols-[300px_1fr] gap-5">
      <Card className="h-fit overflow-hidden">
        <CardHeader title="Vorlagen" description="Reiner Text, Platzhalter in {geschweiften Klammern}" />
        <ul className="pb-2">
          {items.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => setSelected(t.id)}
                className={cn('flex w-full items-center justify-between gap-2 px-5 py-2 text-left text-sm', current.id === t.id ? 'bg-primary-subtle text-primary' : 'text-fg hover:bg-surface-2')}
              >
                <span className="truncate">{t.label}</span>
                <Badge>{KIND_LABELS[t.kind]}</Badge>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <TemplateEditor key={`${current.id}:${current.updatedAt}`} template={current} />
    </div>
  );
}

function TemplateEditor({ template }: { template: TemplateWithHelp }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState(template.label);
  const [subject, setSubject] = useState(template.subject ?? '');
  const [body, setBody] = useState(template.body);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const hasSubject = template.kind !== 'subject';
  const dirty = label !== template.label || body !== template.body || (hasSubject && subject !== (template.subject ?? ''));
  const save = useMutation({
    mutationFn: () => api.put<TemplateWithHelp>(`/api/admin/templates/${template.id}`, { label, body, ...(hasSubject ? { subject: subject || null } : {}) }),
    onSuccess: () => {
      toast.success('Vorlage gespeichert');
      void qc.invalidateQueries({ queryKey: ['admin', 'templates'] });
    },
    onError: (err) => toast.error('Nicht gespeichert', { description: errorMessage(err), duration: 10_000 }),
  });
  useSaveShortcut(() => dirty && !save.isPending && save.mutate(), true, 'Vorlage speichern');

  const insert = (name: string) => {
    const el = bodyRef.current;
    const token = `{${name}}`;
    if (!el) return setBody((b) => b + token);
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const preview = useMemo(() => ({ subject: fill(subject), body: fill(body) }), [subject, body]);

  return (
    <div className="grid grid-cols-1 gap-5 2xl:grid-cols-[1fr_380px]">
      <Card>
        <CardHeader
          title={template.label}
          description={`Zuletzt geändert ${formatDateTime(template.updatedAt)}`}
          actions={
            <Button variant="primary" icon={Save} kbd="Ctrl S" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
              Speichern
            </Button>
          }
        />
        <CardBody className="space-y-4">
          <Input label="Name der Vorlage" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
          {hasSubject && <Input label="Betreff" value={subject} maxLength={300} onChange={(e) => setSubject(e.target.value)} />}
          <Textarea ref={bodyRef} label={template.kind === 'subject' ? 'Betreff' : 'Text'} rows={template.kind === 'subject' ? 2 : 14} maxLength={10_000} value={body} onChange={(e) => setBody(e.target.value)} className="font-mono" />
          <div>
            <p className="mb-2 text-[13px] font-medium text-fg">Platzhalter einfügen</p>
            <div className="flex flex-wrap gap-2">
              {template.placeholders.map((p) => (
                <button key={p.name} type="button" title={p.help} onClick={() => insert(p.name)} className="rounded-md border border-border-strong bg-surface px-2 py-1 font-mono text-xs text-fg-muted hover:border-primary hover:text-primary">
                  {`{${p.name}}`}
                </button>
              ))}
            </div>
            <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-fg-subtle">
              {template.placeholders.map((p) => (
                <li key={p.name}>
                  <span className="font-mono text-fg-muted">{`{${p.name}}`}</span> – {p.help}
                </li>
              ))}
            </ul>
          </div>
        </CardBody>
      </Card>
      <Card className="h-fit">
        <CardHeader title="Vorschau" description="mit Beispielwerten" />
        <CardBody>
          {hasSubject && preview.subject && <p className="mb-3 text-sm font-medium text-fg">{preview.subject}</p>}
          <pre className="font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-fg">{preview.body}</pre>
        </CardBody>
      </Card>
    </div>
  );
}

// =====================================================================================================================
// Einwände
// =====================================================================================================================

export function ObjectionsTab() {
  const objections = useQuery({ queryKey: ['admin', 'objections'], queryFn: () => api.get<{ items: ObjectionAnswer[] }>('/api/admin/objections') });
  const [editing, setEditing] = useState<ObjectionAnswer | 'new' | null>(null);
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (o: ObjectionAnswer) => api.put<ObjectionAnswer>(`/api/admin/objections/${o.id}`, { active: !o.active }),
    onSuccess: (o) => {
      toast.success(o.active ? 'Einwand wieder sichtbar' : 'Einwand ausgeblendet', { action: { label: 'Rückgängig', onClick: () => toggle.mutate(o) } });
      void qc.invalidateQueries({ queryKey: ['admin', 'objections'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  useShortcut('n', () => setEditing('new'), { description: 'Neuer Einwand', group: 'Admin' });
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Einwände und Antworten"
        description="Erscheinen im Spickzettel des Lead-Arbeitsplatzes."
        actions={
          <Button variant="primary" icon={Plus} kbd="N" onClick={() => setEditing('new')}>
            Neuer Einwand
          </Button>
        }
      />
      {objections.isLoading ? (
        <div className="p-5">
          <SkeletonText lines={4} />
        </div>
      ) : !objections.data?.items.length ? (
        <EmptyState icon={MessageSquareQuote} title="Noch keine Einwände" description="Lege die häufigsten Einwände mit einer kurzen Antwort an – Markus sieht sie im Gespräch." />
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Einwand</TH>
              <TH>Antwort</TH>
              <TH align="center">sichtbar</TH>
              <TH />
            </tr>
          </THead>
          <TBody>
            {objections.data.items.map((o) => (
              <TR key={o.id} className={o.active ? undefined : 'opacity-60'}>
                <TD className="w-72 align-top font-medium">{o.label}</TD>
                <TD className="align-top text-fg-muted">{o.answer}</TD>
                <TD align="center" className="align-top">
                  <div className="flex justify-center">
                    <Toggle label={<span className="sr-only">sichtbar</span>} checked={o.active} onChange={() => toggle.mutate(o)} />
                  </div>
                </TD>
                <TD className="align-top">
                  <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(o)}>
                    Bearbeiten
                  </Button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {editing && <ObjectionDialog value={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function ObjectionDialog({ value, onClose }: { value: ObjectionAnswer | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState(value?.label ?? '');
  const [answer, setAnswer] = useState(value?.answer ?? '');
  const [sortOrder, setSortOrder] = useState(value?.sortOrder ?? 0);
  const save = useMutation({
    mutationFn: () =>
      value ? api.put<ObjectionAnswer>(`/api/admin/objections/${value.id}`, { label, answer, sortOrder }) : api.post<ObjectionAnswer>('/api/admin/objections', { label, answer }),
    onSuccess: () => {
      toast.success(value ? 'Einwand gespeichert' : 'Einwand hinzugefügt');
      void qc.invalidateQueries({ queryKey: ['admin', 'objections'] });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const valid = label.trim() && answer.trim();
  return (
    <Dialog
      open
      onClose={onClose}
      title={value ? 'Einwand bearbeiten' : 'Neuer Einwand'}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            Speichern
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Was der Kunde sagt" maxLength={120} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Wir haben schon einen Partner" />
        <Textarea label="Antwort (kurz, in Alltagssprache)" rows={5} maxLength={2000} value={answer} onChange={(e) => setAnswer(e.target.value)} />
        {value && <Input label="Reihenfolge" type="number" min={0} value={sortOrder} onChange={(e) => setSortOrder(Number(e.target.value) || 0)} />}
      </div>
    </Dialog>
  );
}
