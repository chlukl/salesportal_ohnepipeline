/**
 * Anrufmodus (INTENT 6.2): Spickzettel (Einstieg, 2–3 Use Cases, Stichworte, Grösse, Branche, Entscheider),
 * Vorgeschichte in einer Zeile (letzter echter Kontakt, offene Aufgabe, Kampagnen-Mails) and objection answers.
 */
import { employeeBandLabel, formatZurich, optionLabel, useCaseLabel, type ObjectionAnswer } from '@sales-portal/shared';
import { ChevronDown, History, Lightbulb, MessageSquareQuote } from 'lucide-react';
import { useState } from 'react';
import { Badge, Card, cn, GradeBadge } from '@/components/ui';
import type { WorkspaceData } from './types';

export function CheatSheet({ data }: { data: WorkspaceData }) {
  const { lead, useCases } = data;
  const a = lead.assessment;
  return (
    <Card className="border-call-connected/30 px-4 py-3.5">
      <h3 className="mb-2 flex items-center justify-between gap-1.5 text-xs font-semibold tracking-wide text-fg-subtle uppercase">
        <span className="flex items-center gap-1.5">
          <Lightbulb className="size-3.5" aria-hidden /> Spickzettel
        </span>
        <GradeBadge grade={lead.grade} score={lead.kls_leadscore} size="sm" />
      </h3>
      <p className="text-[15px] leading-snug text-fg">{a?.einstieg ?? 'Kein Einstieg hinterlegt – mit dem Use Case starten.'}</p>
      {useCases.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {useCases.map((u) => (
            <li key={u.id} className="text-[13px]">
              <span className="font-medium text-fg">{u.label}</span>
              <span className="block text-xs text-fg-subtle">{u.why}</span>
            </li>
          ))}
        </ul>
      )}
      {a?.stichworte.length ? (
        <div className="mt-3 flex flex-wrap gap-1">
          {a.stichworte.map((s) => (
            <Badge key={s} variant="outline">
              {s}
            </Badge>
          ))}
        </div>
      ) : null}
      <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-2.5 text-[13px]">
        <div>
          <dt className="text-xs text-fg-subtle">Grösse</dt>
          <dd className="text-fg">{lead.numberofemployees != null ? `${lead.numberofemployees} MA` : employeeBandLabel(lead.employeeBand)}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-subtle">Branche</dt>
          <dd className="truncate text-fg" title={lead.kls_industry ?? ''}>
            {lead.kls_industry ?? '–'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-fg-subtle">Entscheider</dt>
          <dd className={cn(lead.decisionmaker ? 'text-success' : 'text-fg')}>{lead.decisionmaker ? 'ja' : lead.decisionmaker === false ? 'nein' : 'unbekannt'}</dd>
        </div>
      </dl>
    </Card>
  );
}

/** «Vorgeschichte in einer Zeile». */
export function HistoryLine({ data }: { data: WorkspaceData }) {
  const { lead, openTasks, campaignMails } = data;
  const c = lead.lastRealContact;
  const parts: string[] = [];
  parts.push(
    c
      ? `Letzter Kontakt ${formatZurich(c.at, 'dd.MM.yyyy')}${c.byName ? ` (${c.byName})` : ''}${c.resultCode != null ? `: ${optionLabel('kls_anrufergebnis', c.resultCode)}` : c.summary ? `: ${c.summary}` : ''}`
      : 'Noch nie erreicht',
  );
  if (openTasks[0]) parts.push(`offene Aufgabe «${openTasks[0].subject}»${openTasks[0].dueAt ? ` bis ${formatZurich(openTasks[0].dueAt, 'dd.MM.')}` : ''}`);
  if (campaignMails.length) {
    const last = campaignMails[campaignMails.length - 1];
    const ucs = [...new Set(campaignMails.flatMap((m) => m.useCaseIds))].map(useCaseLabel);
    parts.push(`${campaignMails.length} Kampagnen-Mail${campaignMails.length > 1 ? 's' : ''} (zuletzt ${formatZurich(last.sentAt, 'dd.MM.')} von ${last.senderName})${ucs.length ? ` – ${ucs.slice(0, 2).join(', ')}` : ''}`);
  }
  return (
    <p className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-[13px] text-fg-muted">
      <History className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" aria-hidden />
      <span>{parts.join(' · ')}</span>
    </p>
  );
}

export function Objections({ items }: { items: ObjectionAnswer[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!items.length) return null;
  return (
    <Card className="px-4 py-3.5">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-fg-subtle uppercase">
        <MessageSquareQuote className="size-3.5" aria-hidden /> Einwände
      </h3>
      <ul className="divide-y divide-border">
        {items.map((o) => (
          <li key={o.id}>
            <button
              type="button"
              aria-expanded={open === o.id}
              onClick={() => setOpen(open === o.id ? null : o.id)}
              className="flex w-full items-center justify-between gap-2 py-1.5 text-left text-[13px] font-medium text-fg hover:text-primary"
            >
              «{o.label}»
              <ChevronDown className={cn('size-3.5 shrink-0 text-fg-subtle transition-transform', open === o.id && 'rotate-180')} aria-hidden />
            </button>
            {open === o.id && <p className="pb-2 text-[13px] leading-relaxed text-fg-muted">{o.answer}</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Campaign mails the lead received (6.17) – for the cheat sheet of former campaign leads. */
export function CampaignMails({ data }: { data: WorkspaceData }) {
  if (!data.campaignMails.length) return null;
  return (
    <Card className="px-4 py-3.5">
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-subtle uppercase">Erhaltene Kampagnen-Mails</h3>
      <ul className="space-y-2">
        {data.campaignMails.map((m) => (
          <li key={m.id} className="text-[13px]">
            <p className="text-fg">
              Mail von {m.senderName} · {formatZurich(m.sentAt, 'dd.MM.yyyy')}
            </p>
            <p className="text-xs text-fg-muted">«{m.subject}»</p>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {m.useCaseIds.map((u) => (
                <Badge key={u} variant="outline">
                  {useCaseLabel(u)}
                </Badge>
              ))}
              {m.reactions
                .filter((r) => r.kind !== 'opened')
                .map((r, i) => (
                  <Badge key={i} tone={r.kind === 'replied_positive' ? 'success' : 'neutral'}>
                    {r.kind === 'clicked' ? 'Klick' : r.kind === 'replied_positive' ? 'positive Antwort' : r.kind === 'replied' ? 'Antwort' : r.kind}
                  </Badge>
                ))}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
