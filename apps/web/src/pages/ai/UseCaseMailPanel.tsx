/**
 * Use-Case-Mail (INTENT 6.7) als Seitenfenster im Arbeitsplatz: KI-Entwurf aus KI-Bewertung + Notiz (+ kleine Recherche),
 * Markus bearbeitet und sendet selbst. Nach dem Senden wird die Mail als E-Mail-Aktivität am Lead gespeichert.
 *
 * Layout: fluid (füllt die rechte Spalte des Arbeitsplatzes, 380/440px) ohne eigenen Rahmen – die Spalte ist schon eine
 * Card. Die Fusszeile mit «Senden» klebt am unteren Rand des Scrollbereichs, damit sie immer sichtbar bleibt.
 */
import { useCaseLabel } from '@sales-portal/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileSearch, RotateCcw, Send, Sparkles, TriangleAlert, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api, errorMessage } from '@/app/api';
import { useShortcut } from '@/app/shortcuts';
import { toast } from '@/app/toast';
import { Badge, Button, EmptyState, IconButton, Input, SkeletonText, Textarea, Toggle } from '@/components/ui';
import type { DraftMailResponse, SendMailResponse } from './types';

export interface UseCaseMailPanelProps {
  leadId: string;
  callSessionId?: string | null;
  onClose: () => void;
}

const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;

function parseRecipients(value: string): string[] {
  return value
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function UseCaseMailPanel({ leadId, callSessionId, onClose }: UseCaseMailPanelProps) {
  const queryClient = useQueryClient();
  const [research, setResearch] = useState(true);
  const [includeProposals, setIncludeProposals] = useState(false);
  const [draft, setDraft] = useState<DraftMailResponse | null>(null);
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sent, setSent] = useState<SendMailResponse | null>(null);

  const create = useMutation({
    mutationFn: () => api.post<DraftMailResponse>('/api/ai/use-case-mail/draft', { leadId, callSessionId: callSessionId ?? null, research, includeProposals }),
    onSuccess: (res) => {
      setDraft(res);
      setTo(res.to ?? '');
      setSubject(res.draft.subject);
      setBody(res.draft.body);
      setSent(null);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const recipients = parseRecipients(to);
  const recipientsValid = recipients.length > 0 && recipients.length <= 5 && recipients.every((r) => EMAIL_RE.test(r));
  const subjectValid = subject.trim().length > 0 && !/[\r\n]/.test(subject);
  const canSend = !!draft && recipientsValid && subjectValid && body.trim().length > 0;

  const send = useMutation({
    mutationFn: () => api.post<SendMailResponse>(`/api/ai/use-case-mail/${draft!.analysis.id}/send`, { to: recipients, subject: subject.trim(), body }),
    onSuccess: (res) => {
      setSent(res);
      void queryClient.invalidateQueries({ queryKey: ['workspace'] });
      void queryClient.invalidateQueries({ queryKey: ['pendenzen'] });
      if (res.activity.status === 'pushed') toast.success('Mail gesendet', { description: 'Als E-Mail-Aktivität am Lead gespeichert.' });
      else toast.warning('Mail gesendet – CRM-Eintrag fehlt noch', { description: 'Der Eintrag liegt unter Pendenzen › Fehler und kann erneut versucht werden.' });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const discard = useMutation({
    mutationFn: () => api.post(`/api/ai/use-case-mail/${draft!.analysis.id}/discard`),
    onSuccess: () => {
      setDraft(null);
      onClose();
    },
  });

  const primary = () => {
    if (!draft && !create.isPending) create.mutate();
    else if (draft && !sent && canSend && !send.isPending) send.mutate();
  };
  useShortcut('mod+enter', primary, { description: draft ? 'Mail senden' : 'Mail-Entwurf erstellen', group: 'Use-Case-Mail', allowInInput: true });
  // Esc nur ausserhalb der Eingabefelder: ein Tastendruck im Text darf den Entwurf nicht wegwerfen.
  useShortcut('escape', onClose, { description: 'Mail-Fenster schliessen', group: 'Use-Case-Mail' });

  const footer = sent ? (
    <Button variant="primary" onClick={onClose}>
      Schliessen
    </Button>
  ) : draft ? (
    <>
      <Button variant="ghost" onClick={() => discard.mutate()} loading={discard.isPending}>
        Verwerfen
      </Button>
      <Button icon={RotateCcw} onClick={() => create.mutate()} loading={create.isPending}>
        Neu entwerfen
      </Button>
      <Button variant="primary" icon={Send} onClick={() => send.mutate()} loading={send.isPending} disabled={!canSend} kbd="Ctrl ↵">
        Senden
      </Button>
    </>
  ) : (
    <Button variant="primary" icon={Sparkles} onClick={() => create.mutate()} loading={create.isPending} kbd="Ctrl ↵">
      Entwurf erstellen
    </Button>
  );

  return (
    <FluidPanel title="Use-Case-Mail" description="Entwurf aus deiner Sicht – du prüfst und sendest selbst." onClose={onClose} footer={footer}>
      {sent ? (
        <EmptyState
          compact
          icon={CheckCircle2}
          title="Mail gesendet"
          description={
            sent.sent.redirected
              ? `Testmodus: Die Mail ging an ${sent.sent.deliveredTo.join(', ')} statt an den Kunden.`
              : `Gesendet an ${sent.sent.deliveredTo.join(', ')}.`
          }
        />
      ) : create.isPending ? (
        <div className="space-y-3" aria-busy>
          <p className="text-sm text-fg-muted">Die KI schreibt den Entwurf …</p>
          <SkeletonText lines={8} />
        </div>
      ) : !draft ? (
        <div className="space-y-5">
          <p className="text-sm text-fg-muted">
            Die KI nimmt die KI-Bewertung und deine Gesprächsnotiz und schlägt 1–2 passende Use Cases mit Terminangebot vor. Aufhänger nur mit Quelle – nichts Erfundenes.
          </p>
          <Toggle checked={research} onChange={setResearch} label="Kleine Recherche" description="Liest die Website der Firma (nur öffentliche https-Seiten)." />
          <Toggle checked={includeProposals} onChange={setIncludeProposals} label="3 Terminvorschläge einfügen" description="Wenn der Terminplaner Vorschläge liefern kann." />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="primary" variant="outline">
              KI-Entwurf
            </Badge>
            {draft.draft.useCaseIds.map((id) => (
              <Badge key={id}>{useCaseLabel(id)}</Badge>
            ))}
            {draft.research.requested &&
              (draft.research.ok ? (
                <Badge tone="info">
                  <FileSearch className="size-3" aria-hidden />
                  {draft.research.demo ? 'Demo-Recherche' : 'Website gelesen'}
                </Badge>
              ) : (
                <Badge tone="warning" title={draft.research.error ?? undefined}>
                  Recherche nicht möglich
                </Badge>
              ))}
            {includeProposals && !draft.proposalsIncluded && <Badge tone="neutral">ohne Terminvorschläge</Badge>}
          </div>
          <Input
            label="An"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            error={to && !recipientsValid ? 'Bitte gültige E-Mail-Adressen (max. 5), getrennt mit Komma' : undefined}
            hint={!to ? 'Keine E-Mail-Adresse im CRM – bitte eintragen.' : undefined}
          />
          <Input label="Betreff" value={subject} onChange={(e) => setSubject(e.target.value.replace(/[\r\n]/g, ' '))} maxLength={200} />
          <Textarea label="Text" rows={16} value={body} onChange={(e) => setBody(e.target.value)} maxLength={10_000} />
          {draft.draft.sources.length > 0 && (
            <section>
              <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-fg-subtle uppercase">Quellen der Aufhänger</h4>
              <ul className="space-y-1 text-[13px]">
                {draft.draft.sources.map((s, i) => (
                  <li key={i} className="text-fg-muted">
                    <span className="text-fg">{s.claim}</span> – {s.source}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p className="flex items-start gap-2 rounded-md bg-surface-2 p-3 text-xs text-fg-muted">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Bitte vor dem Senden lesen: Der Text ist ein Vorschlag der KI. Gesendet wird aus deinem Postfach, gespeichert als E-Mail-Aktivität am Lead.
          </p>
        </div>
      )}
    </FluidPanel>
  );
}

/** Fluid panel for the workspace column: no fixed width, no extra frame, footer sticky at the bottom of the column. */
function FluidPanel({ title, description, onClose, footer, children }: { title: string; description: string; onClose: () => void; footer: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex w-full min-w-0 flex-col">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
          <p className="mt-0.5 text-[13px] text-fg-muted">{description}</p>
        </div>
        <IconButton icon={X} label="Schliessen (Esc)" size="sm" onClick={onClose} />
      </header>
      <div className="min-w-0">{children}</div>
      <footer className="sticky bottom-0 z-10 -mx-4 mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface px-4 py-3">{footer}</footer>
    </section>
  );
}
