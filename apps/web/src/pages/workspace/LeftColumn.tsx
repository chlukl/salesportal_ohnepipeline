/**
 * Left column of the workspace (INTENT 6.2): company, contact person, all persons of the company, contact data with
 * normalized phones («Nummer prüfen»), score badge, Einstieg, Stichworte, nächster Schritt, open tasks, campaign.
 */
import {
  CONTACT_ROLE_LABELS,
  employeeBandLabel,
  formatZurich,
  optionLabel,
  ORG_TYPE_LABELS,
  type CompanyPerson,
  type CrmTask,
  type Lead,
  type LeadPhone,
} from '@sales-portal/shared';
import { AlertTriangle, Building2, ChevronDown, Globe, Mail, Phone, Smartphone, Sparkles, Users } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Badge, Card, cn, GradeBadge } from '@/components/ui';

function Block({ title, icon: Icon, children, action }: { title: string; icon: typeof Building2; children: ReactNode; action?: ReactNode }) {
  return (
    <Card className="px-4 py-3.5">
      <h3 className="mb-2.5 flex items-center justify-between gap-2 text-xs font-semibold tracking-wide text-fg-subtle uppercase">
        <span className="flex items-center gap-1.5">
          <Icon className="size-3.5" aria-hidden /> {title}
        </span>
        {action}
      </h3>
      {children}
    </Card>
  );
}

/** Only http(s) links from CRM data. */
function safeUrl(url: string | null): string | null {
  if (!url) return null;
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function PhoneRow({ phone, onCall, disabled }: { phone: LeadPhone; onCall?: (e164: string) => void; disabled?: boolean }) {
  const Icon = phone.type === 'mobile' || phone.field === 'mobilephone' ? Smartphone : Phone;
  const label = phone.field === 'mobilephone' ? 'Mobile' : 'Telefon';
  if (phone.status === 'empty') return null;
  if (phone.status !== 'ok' || !phone.e164) {
    return (
      <div className="flex items-start gap-2 text-[13px]">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
        <div>
          <span className="text-fg-muted">{phone.raw}</span>
          <p className="text-xs text-warning">{phone.issue ?? 'Nummer prüfen'}</p>
        </div>
      </div>
    );
  }
  return (
    <button
      type="button"
      disabled={disabled || !onCall}
      onClick={() => onCall?.(phone.e164!)}
      title={onCall ? `${label} anrufen` : undefined}
      className="group flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-[13px] enabled:hover:bg-primary-subtle disabled:cursor-default"
    >
      <Icon className="size-3.5 text-fg-subtle group-enabled:group-hover:text-primary" aria-hidden />
      <span className="tabular font-medium text-fg group-enabled:group-hover:text-primary">{phone.display}</span>
      {phone.extension && <span className="text-xs text-fg-subtle">Durchwahl {phone.extension}</span>}
      <span className="ml-auto text-xs text-fg-subtle">{label}</span>
    </button>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-[13px]">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="text-right text-fg">{value ?? '–'}</dd>
    </div>
  );
}

export function CompanyBlock({ lead }: { lead: Lead }) {
  const url = safeUrl(lead.websiteurl);
  return (
    <Block title="Firma" icon={Building2}>
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="text-[15px] leading-snug font-semibold text-fg">{lead.companyname}</p>
        <GradeBadge grade={lead.grade} score={lead.kls_leadscore} size="lg" />
      </div>
      <dl className="space-y-1">
        <Fact label="Mitarbeitende" value={lead.numberofemployees != null ? `${lead.numberofemployees.toLocaleString('de-CH')} (${employeeBandLabel(lead.employeeBand)})` : 'unbekannt'} />
        <Fact label="Branche" value={lead.kls_industry ?? <span className="text-warning">fehlt</span>} />
        {lead.kls_custom_industry && <Fact label="Kategorie" value={lead.kls_custom_industry} />}
        <Fact label="Organisation" value={ORG_TYPE_LABELS[lead.orgType]} />
        <Fact label="Ort" value={[lead.address1_postalcode, lead.address1_city, lead.address1_stateorprovince].filter(Boolean).join(' ') || '–'} />
        <Fact label="Besitzer" value={lead.ownerName} />
        <Fact label="Statusgrund" value={optionLabel('statuscode', lead.statuscode)} />
      </dl>
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1.5 text-[13px] text-primary hover:underline">
          <Globe className="size-3.5" aria-hidden /> {lead.domain ?? url}
        </a>
      )}
      <div className="mt-2 flex flex-wrap gap-1">
        {lead.campaign.fromCampaign && <Badge tone="info">aus Kampagne</Badge>}
        {lead.campaign.locked && <Badge tone="warning">Kampagne gesperrt bis {lead.campaign.lockedUntil ? formatZurich(lead.campaign.lockedUntil, 'dd.MM.yyyy') : '…'}</Badge>}
        {lead.kls_callstatus && <Badge>{optionLabel('kls_callstatus', lead.kls_callstatus)}</Badge>}
        {lead.kls_rating_category && <Badge variant="outline">{optionLabel('kls_rating_category', lead.kls_rating_category)}</Badge>}
      </div>
    </Block>
  );
}

export function ContactBlock({ lead, onCall, callDisabled }: { lead: Lead; onCall?: (e164: string) => void; callDisabled?: boolean }) {
  const phones = lead.phones.filter((p) => p.status !== 'empty');
  return (
    <Block title="Ansprechperson" icon={Phone}>
      <p className="font-medium text-fg">
        {lead.fullname ?? 'ohne Namen'}
        {lead.decisionmaker && (
          <Badge tone="success" className="ml-2">
            Entscheider
          </Badge>
        )}
      </p>
      <p className="mb-2 text-[13px] text-fg-muted">{[lead.jobtitle, CONTACT_ROLE_LABELS[lead.contactRole]].filter(Boolean).join(' · ')}</p>
      <div className="space-y-0.5">
        {phones.length ? phones.map((p) => <PhoneRow key={p.field} phone={p} onCall={onCall} disabled={callDisabled} />) : <p className="text-[13px] text-warning">Keine Nummer – Nummer prüfen</p>}
        {lead.emailaddress1 && (
          <p className="flex items-center gap-2 px-1 py-0.5 text-[13px] text-fg-muted">
            <Mail className="size-3.5 text-fg-subtle" aria-hidden /> {lead.emailaddress1}
          </p>
        )}
      </div>
      {(lead.donotphone || lead.donotemail) && (
        <p className="mt-2 text-xs text-danger">{[lead.donotphone && 'nicht anrufen', lead.donotemail && 'keine E-Mails'].filter(Boolean).join(' · ')}</p>
      )}
    </Block>
  );
}

export function AssessmentBlock({ lead }: { lead: Lead }) {
  const [open, setOpen] = useState(false);
  const a = lead.assessment;
  return (
    <Block title="KI-Bewertung" icon={Sparkles}>
      {!a ? (
        <p className="text-[13px] text-fg-subtle">Noch keine KI-Bewertung für diesen Lead.</p>
      ) : (
        <div className="space-y-2 text-[13px]">
          {a.einstieg && (
            <div>
              <p className="text-xs text-fg-subtle">Einstieg</p>
              <p className="text-fg">{a.einstieg}</p>
            </div>
          )}
          {a.stichworte.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {a.stichworte.map((s) => (
                <Badge key={s} variant="outline">
                  {s}
                </Badge>
              ))}
            </div>
          )}
          {a.naechsterSchritt && (
            <div>
              <p className="text-xs text-fg-subtle">Nächster Schritt</p>
              <p className="text-fg">{a.naechsterSchritt}</p>
            </div>
          )}
          {(a.details.length > 0 || a.stand) && (
            <>
              <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-primary" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
                Details <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
              </button>
              {open && (
                <div className="space-y-1 text-xs whitespace-pre-wrap text-fg-muted">
                  {a.stand && <p>Stand: {a.stand}</p>}
                  {a.details.map((d, i) => (
                    <p key={i}>{d}</p>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Block>
  );
}

export function PersonsBlock({ persons, onOpen, collapsible = false }: { persons: CompanyPerson[]; onOpen: (leadId: string) => void; collapsible?: boolean }) {
  const others = persons.filter((p) => !p.isCurrent);
  // In the call mode the list starts folded (count in the title) – «Da müssen Sie mit Herrn X sprechen» → one click.
  const [open, setOpen] = useState(!collapsible);
  return (
    <Block
      title={`Personen der Firma · ${persons.length}`}
      icon={Users}
      action={
        collapsible && others.length > 0 ? (
          <button type="button" className="inline-flex items-center gap-1 text-xs font-medium normal-case text-primary" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'einklappen' : 'zeigen'} <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
          </button>
        ) : undefined
      }
    >
      {!open ? (
        <p className="text-[13px] text-fg-subtle">{others.length} weitere Person{others.length === 1 ? '' : 'en'} im CRM</p>
      ) : others.length === 0 ? (
        <p className="text-[13px] text-fg-subtle">Keine weiteren Personen im CRM.</p>
      ) : (
        <ul className="space-y-2">
          {others.map((p) => {
            const phone = p.phones.find((x) => x.status === 'ok');
            const body = (
              <>
                <span className="flex items-center gap-1.5 font-medium text-fg">
                  {p.fullName}
                  {p.source === 'contact' && <Badge>Kontakt</Badge>}
                  {p.statecode === 2 && <Badge>geschlossen</Badge>}
                  {p.decisionmaker && <Badge tone="success">Entscheider</Badge>}
                </span>
                <span className="block text-xs text-fg-muted">{[p.jobtitle, phone?.display, p.email].filter(Boolean).join(' · ') || CONTACT_ROLE_LABELS[p.contactRole]}</span>
                {p.lastRealContact && <span className="block text-xs text-fg-subtle">letzter Kontakt {formatZurich(p.lastRealContact.at, 'dd.MM.yyyy')}</span>}
              </>
            );
            return (
              <li key={`${p.source}-${p.id}`} className="text-[13px]">
                {p.source === 'lead' ? (
                  <button type="button" className="w-full rounded-md px-1 py-0.5 text-left hover:bg-surface-2" onClick={() => onOpen(p.id)}>
                    {body}
                  </button>
                ) : (
                  <div className="px-1 py-0.5">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Block>
  );
}

export function TasksBlock({ tasks }: { tasks: CrmTask[] }) {
  if (!tasks.length) return null;
  const now = Date.now();
  return (
    <Block title="Offene Aufgaben" icon={AlertTriangle}>
      <ul className="space-y-1.5 text-[13px]">
        {tasks.map((t) => (
          <li key={t.id}>
            <p className="text-fg">{t.subject}</p>
            <p className={cn('text-xs', t.dueAt && Date.parse(t.dueAt) < now ? 'text-danger' : 'text-fg-subtle')}>
              {t.dueAt ? `fällig ${formatZurich(t.dueAt, 'dd.MM.yyyy HH:mm')}` : 'ohne Datum'} · {t.ownerName ?? '–'}
            </p>
          </li>
        ))}
      </ul>
    </Block>
  );
}
