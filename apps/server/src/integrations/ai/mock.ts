/**
 * Mock AI: deterministic, plausible suggestions derived from note/transcript keywords and the lead's assessment.
 * No network, no cost (usage = null). Output goes through the same zod validation as the live adapter.
 */
import {
  formatZurich,
  parseAssessment,
  useCaseLabel,
  zurichDate,
  type AiCallContext,
  type Briefing,
  type CallAnalysis,
  type Lead,
  type Objection,
  type ResultGroupKey,
  type UseCaseMailDraft,
} from '@sales-portal/shared';
import type { AdapterDeps } from '../types';
import { sanitizeBriefing, sanitizeCallAnalysis, sanitizeUseCaseMail } from './schemas';
import type { AiAdapter, AiResult, BriefingRequest, UseCaseMailRequest } from './types';

const MOCK_MODEL = 'mock-ai';

/** Keyword → use case (catalog ids in i18n.ts). Order = priority. */
const USE_CASE_KEYWORDS: { id: string; words: string[] }[] = [
  { id: 'UC-DOC', words: ['rechnung', 'beleg', 'kreditoren', 'buchhaltung'] },
  { id: 'UC-OFFER', words: ['offerte', 'angebot', 'kalkulation'] },
  { id: 'UC-ORDER', words: ['bestellung', 'auftrag', 'erp'] },
  { id: 'UC-MAIL', words: ['mail', 'posteingang', 'anfragen'] },
  { id: 'UC-KNOW', words: ['wissen', 'dokument', 'handbuch', 'suche'] },
  { id: 'UC-QA', words: ['qualität', 'prüf', 'protokoll'] },
  { id: 'UC-REPORT', words: ['bericht', 'report', 'kennzahl', 'auswertung'] },
  { id: 'UC-SERVICE', words: ['service', 'support', 'kundendienst'] },
  { id: 'UC-TENDER', words: ['ausschreibung', 'plan', 'submission'] },
  { id: 'UC-HR', words: ['bewerbung', 'personal', 'hr'] },
];

const OBJECTION_KEYWORDS: { key: Objection; words: string[] }[] = [
  { key: 'partner', words: ['partner', 'dienstleister', 'unsere it macht'] },
  { key: 'internal_group', words: ['konzern', 'mutterhaus', 'gruppe entscheidet', 'intern gelöst'] },
  { key: 'too_small', words: ['zu klein', 'nur wenige mitarbeitende'] },
  { key: 'no_budget', words: ['kein budget', 'budget ist ausgeschöpft', 'zu teuer'] },
  { key: 'bad_timing', words: ['keine zeit', 'später', 'nach den ferien', 'nächstes jahr', 'ende q'] },
  { key: 'no_interest', words: ['kein interesse', 'brauchen wir nicht'] },
];

/** Small deterministic hash (stable across runs) for picking phrasing variants. */
export function stableHash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function corpus(ctx: Pick<AiCallContext, 'note' | 'transcript'>): string {
  const transcript = ctx.transcript?.segments.map((s) => s.text).join(' ') ?? '';
  return `${ctx.note ?? ''} ${transcript}`.toLowerCase();
}

export function detectUseCases(text: string, lead: Lead): string[] {
  const found = USE_CASE_KEYWORDS.filter((u) => u.words.some((w) => text.includes(w))).map((u) => u.id);
  if (found.length) return found.slice(0, 3);
  // Fall back to keywords of the KI-Bewertung.
  const stichworte = (parseAssessment(lead.kls_ki_bewertung)?.stichworte ?? []).join(' ').toLowerCase();
  const fromAssessment = USE_CASE_KEYWORDS.filter((u) => u.words.some((w) => stichworte.includes(w))).map((u) => u.id);
  return (fromAssessment.length ? fromAssessment : ['UC-DOC']).slice(0, 2);
}

export function detectObjections(text: string): Objection[] {
  return OBJECTION_KEYWORDS.filter((o) => o.words.some((w) => text.includes(w))).map((o) => o.key);
}

export function detectInterest(text: string, objections: Objection[]): 0 | 1 | 2 | 3 {
  if (objections.includes('no_interest')) return 0;
  if (/(termin|gerne|klingt (gut|spannend)|zeigen sie)/.test(text)) return 3;
  if (/(interessant|schicken sie|unterlagen|mail)/.test(text)) return 2;
  if (objections.length) return 1;
  return 1;
}

/** «nächste Woche», «in zwei Wochen», «nach den Ferien», «Ende Q1» → date (Zurich). */
export function detectNextStepDate(text: string, now: Date): string | null {
  const add = (days: number) => zurichDate(new Date(now.getTime() + days * 86_400_000));
  if (text.includes('morgen')) return add(1);
  if (text.includes('nächste woche') || text.includes('naechste woche')) return add(7);
  if (text.includes('zwei wochen') || text.includes('2 wochen')) return add(14);
  if (text.includes('nach den ferien')) return add(30);
  const q = /ende q([1-4])/.exec(text);
  if (q) {
    const year = Number(zurichDate(now).slice(0, 4));
    const month = Number(q[1]) * 3;
    const candidate = `${year}-${String(month).padStart(2, '0')}-${month === 6 || month === 9 ? '30' : '31'}`;
    return candidate > zurichDate(now) ? candidate : `${year + 1}-${candidate.slice(5)}`;
  }
  return null;
}

function suggestGroup(text: string, interest: number, objections: Objection[]): ResultGroupKey | null {
  if (objections.includes('internal_group')) return 'internal_group';
  if (objections.includes('partner') && interest <= 1) return 'has_partner';
  if (objections.includes('no_interest')) return 'no_need';
  if (text.includes('termin') && interest >= 3) return 'meeting_booked';
  if (/(mail|unterlagen|schicken sie)/.test(text)) return 'info_mail';
  if (objections.includes('bad_timing')) return 'later';
  if (interest >= 2) return 'waiting';
  return null;
}

function contactName(lead: Lead): string {
  return [lead.firstname, lead.lastname].filter(Boolean).join(' ') || 'die Ansprechperson';
}

/** Find a quote spoken by the callee that contains an interest signal. */
function findQuote(ctx: AiCallContext): string | null {
  const callee = ctx.transcript?.segments.filter((s) => s.speaker === 'callee') ?? [];
  const hit = callee.find((s) => /(termin|gerne|interessant|klingt|kein interesse|partner|budget)/i.test(s.text)) ?? callee[0];
  return hit ? hit.text.slice(0, 300) : null;
}

function forwardedPerson(text: string): { name: string | null; jobtitle: string | null; email: string | null } | null {
  const m = /(?:zuständig ist|wenden sie sich an|weiterleiten an)\s+(?:frau|herr)?\s*([A-ZÄÖÜ][a-zäöüé]+(?:\s+[A-ZÄÖÜ][a-zäöüé]+)?)/.exec(text);
  if (!m) return null;
  const email = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(text)?.[0] ?? null;
  return { name: m[1], jobtitle: null, email };
}

export class MockAiAdapter implements AiAdapter {
  readonly mode = 'mock' as const;

  constructor(private readonly deps: AdapterDeps) {}

  async analyzeCall(ctx: AiCallContext): Promise<AiResult<CallAnalysis>> {
    const now = this.deps.now();
    const rawText = `${ctx.note ?? ''} ${ctx.transcript?.segments.map((s) => s.text).join(' ') ?? ''}`;
    const text = corpus(ctx);
    const objections = detectObjections(text);
    const interest = detectInterest(text, objections);
    const useCases = detectUseCases(text, ctx.lead);
    const nextStepDate = detectNextStepDate(text, now);
    const group = suggestGroup(text, interest, objections);
    const forwarded = forwardedPerson(rawText);
    const reached: CallAnalysis['decisionMaker']['reached'] = forwarded
      ? 'forwarded'
      : /(geschäftsführ|inhaber|ceo|leiter)/i.test(`${ctx.lead.jobtitle ?? ''} ${text}`) || ctx.lead.decisionmaker
        ? 'yes'
        : 'no';
    const person = contactName(ctx.lead);
    const when = nextStepDate ? formatZurich(`${nextStepDate}T12:00:00Z`, 'dd.MM.yyyy') : null;
    const sentences = [
      `${person} (${ctx.lead.jobtitle ?? 'Funktion unbekannt'}) von ${ctx.lead.companyname} wurde erreicht.`,
      useCases.length
        ? `Genannt wurden Themen rund um ${useCases.map((u) => useCaseLabel(u)).join(' und ')}.`
        : 'Konkrete Abläufe wurden nicht genannt.',
      interest >= 2 ? 'Das Interesse an einem kurzen Austausch ist vorhanden.' : 'Das Interesse ist eher zurückhaltend.',
      objections.length ? `Einwände: ${objections.map((o) => OBJECTION_LABEL[o]).join(', ')}.` : null,
      when ? `Nächster Schritt bis ${when}.` : 'Ein konkreter Zeitpunkt wurde nicht vereinbart.',
    ].filter((s): s is string => !!s);

    const fields: CallAnalysis['suggestion']['fields'] = [];
    if (reached === 'yes' && ctx.lead.decisionmaker !== true) {
      fields.push({ field: 'decisionmaker', value: true, reason: 'Entscheider war im Gespräch' });
    }
    const employees = /(\d{1,4})\s*(mitarbeitende|mitarbeiter|leute|personen)/i.exec(rawText);
    if (employees && Number(employees[1]) !== ctx.lead.numberofemployees) {
      fields.push({ field: 'numberofemployees', value: Number(employees[1]), reason: `Im Gespräch genannt: «${employees[0]}»` });
    }

    const result = sanitizeCallAnalysis({
      summary: sentences.slice(0, 5).join(' '),
      interest: { level: interest, reason: INTEREST_REASON[interest], quote: findQuote(ctx) },
      needs: useCases.map((id) => ({ text: useCaseLabel(id), useCaseIds: [id] })),
      decisionMaker: { reached, forwardedTo: forwarded },
      objections,
      suggestion: {
        resultGroup: group,
        nextStep: group === 'info_mail' ? 'Use-Case-Mail senden und nachfassen' : group === 'meeting_booked' ? 'Erstgespräch vorbereiten' : when ? 'Nachfassen' : null,
        nextStepDate,
        fields,
        preparationNeeded: /(demo|prototyp|unterlagen vorbereiten)/.test(text),
      },
    });
    return { result, model: MOCK_MODEL, usage: null };
  }

  async draftUseCaseMail(req: UseCaseMailRequest): Promise<AiResult<UseCaseMailDraft>> {
    const lead = req.lead;
    const text = corpus(req);
    const useCases = detectUseCases(text, lead).slice(0, 2);
    const assessment = parseAssessment(lead.kls_ki_bewertung);
    const salutation = lead.kls_salutation === 845140001 ? 'Frau' : lead.kls_salutation === 845140000 ? 'Herr' : null;
    const greeting = salutation && lead.lastname ? `Guten Tag ${salutation} ${lead.lastname}` : 'Guten Tag';
    const sources: UseCaseMailDraft['sources'] = [];
    const intro: string[] = [];
    if (req.note?.trim()) {
      intro.push('Vielen Dank für das kurze Gespräch. Wie besprochen schicke ich Ihnen ein paar Beispiele, wo KI bei Ihnen konkret Zeit sparen kann.');
      sources.push({ claim: 'Bezug auf das Telefonat', source: 'Notiz zum Gespräch' });
    } else {
      intro.push(`Ich habe Sie telefonisch leider nicht erreicht und melde mich darum kurz per Mail.`);
    }
    if (assessment?.einstieg) {
      intro.push(assessment.einstieg);
      sources.push({ claim: assessment.einstieg, source: 'KI-Bewertung im CRM' });
    } else if (lead.kls_industry) {
      intro.push(`Gerade in der Branche ${lead.kls_industry} sehen wir oft wiederkehrende Abläufe, die sich gut automatisieren lassen.`);
      sources.push({ claim: `Branche ${lead.kls_industry}`, source: 'CRM: Branche' });
    }
    if (req.research && req.researchText) {
      sources.push({ claim: 'Angebot und Tätigkeit der Firma', source: req.researchSource ?? 'Website' });
    }
    const ucLines = useCases.map((id, i) => `${i + 1}. ${useCaseLabel(id)}: ${UC_BLURB[id] ?? 'wiederkehrende Arbeit automatisch erledigen.'}`);
    const offer = req.proposalsText?.trim()
      ? `Gerne zeigen wir Ihnen das in 30 Minuten über Teams. Passt Ihnen einer dieser Termine?\n\n${req.proposalsText.trim()}`
      : 'Gerne zeigen wir Ihnen das in 30 Minuten über Teams – an Beispielen aus Ihrem Alltag. Welche Tage passen Ihnen in den nächsten Wochen?';
    const body = [greeting, '', intro.join(' '), '', ...ucLines, '', offer, '', 'Freundliche Grüsse', req.senderName, 'Kallysoft Informatik AG'].join('\n');
    const result = sanitizeUseCaseMail({
      subject: `${lead.companyname}: ${useCaseLabel(useCases[0])} mit KI`,
      body,
      useCaseIds: useCases,
      sources,
    });
    return { result, model: MOCK_MODEL, usage: null };
  }

  async buildBriefing(req: BriefingRequest): Promise<AiResult<Briefing>> {
    const lead = req.lead;
    const assessment = parseAssessment(lead.kls_ki_bewertung);
    const text = corpus(req);
    const useCases = detectUseCases(`${text} ${(assessment?.stichworte ?? []).join(' ').toLowerCase()}`, lead).slice(0, 3);
    const calls = req.timeline.filter((t) => t.type === 'phonecall' && t.isRealContact);
    const lastCall = calls[0];
    const campaignContext = req.campaignMails.length
      ? req.campaignMails
          .map(
            (m) =>
              `${formatZurich(m.sentAt, 'dd.MM.yyyy')}: Mail von ${m.senderName} «${m.subject}» – Use Cases: ${
                m.useCaseIds.map(useCaseLabel).join(', ') || 'keine'
              }; Reaktion: ${m.reactions.length ? m.reactions.map((r) => REACTION_LABEL[r.kind] ?? r.kind).join(', ') : 'keine'}`,
          )
          .join('\n')
      : null;
    const history = [
      req.note?.trim() ? `Coldcall: ${req.note.trim().slice(0, 600)}` : null,
      lastCall ? `Letztes Gespräch ${formatZurich(lastCall.at, 'dd.MM.yyyy')}${lastCall.ownerName ? ` (${lastCall.ownerName})` : ''}: ${(lastCall.text ?? lastCall.subject ?? '').slice(0, 400)}` : null,
      `${calls.length} echte Gespräche im Verlauf.`,
    ]
      .filter(Boolean)
      .join('\n');
    const result = sanitizeBriefing({
      company: lead.companyname,
      profile: [
        lead.kls_industry ? `Branche ${lead.kls_industry}` : null,
        lead.numberofemployees ? `${lead.numberofemployees} Mitarbeitende` : 'Grösse unbekannt',
        lead.address1_city ? `Sitz in ${lead.address1_city}` : null,
        assessment?.stand ?? null,
      ]
        .filter(Boolean)
        .join(', '),
      contact: `${contactName(lead)}${lead.jobtitle ? `, ${lead.jobtitle}` : ''}${lead.decisionmaker ? ' (Entscheider)' : ''}`,
      campaignContext,
      history,
      useCases: useCases.map((id) => ({ id, why: `Für ${req.salesName}: ${UC_BLURB[id] ?? useCaseLabel(id)}` })),
      openingQuestions: [
        'Wo verlieren Sie heute im Alltag am meisten Zeit mit Routinearbeit?',
        useCases[0] ? `Wie läuft das Thema «${useCaseLabel(useCases[0])}» heute bei Ihnen ab?` : 'Welche Systeme setzen Sie heute ein?',
        'Wer wäre bei einem ersten Projekt intern beteiligt?',
      ],
      openPoints: [
        lead.decisionmaker ? null : 'Entscheider noch nicht bestätigt',
        text.includes('budget') ? 'Budget wurde angesprochen – Rahmen klären' : null,
      ].filter((p): p is string => !!p),
      preparation: req.booking.needsPreparation
        ? [req.booking.preparationNote?.trim() || 'Vorbereitung laut Buchung nötig (Details mit Markus klären)']
        : ['Keine besondere Vorbereitung nötig'],
    });
    return { result, model: MOCK_MODEL, usage: null };
  }
}

const OBJECTION_LABEL: Record<Objection, string> = {
  partner: 'hat Partner',
  internal_group: 'intern / Konzern',
  too_small: 'zu klein',
  no_budget: 'kein Budget',
  bad_timing: 'falscher Zeitpunkt',
  no_interest: 'kein Interesse',
};

const INTEREST_REASON: Record<0 | 1 | 2 | 3, string> = {
  0: 'Klar kein Interesse geäussert.',
  1: 'Zurückhaltend, kein konkreter Bedarf genannt.',
  2: 'Offen für Informationen, möchte mehr erfahren.',
  3: 'Klares Interesse, konkreter nächster Schritt.',
};

const REACTION_LABEL: Record<string, string> = {
  opened: 'geöffnet',
  clicked: 'Link geklickt',
  replied: 'geantwortet',
  replied_positive: 'positiv geantwortet',
  replied_negative: 'negativ geantwortet',
  bounced: 'unzustellbar',
  unsubscribed: 'abgemeldet',
};

const UC_BLURB: Record<string, string> = {
  'UC-DOC': 'Belege und Rechnungen werden automatisch gelesen und vorkontiert.',
  'UC-OFFER': 'Offerten entstehen aus Anfrage und Vorlagen in Minuten statt Stunden.',
  'UC-MAIL': 'Eingehende Mails werden sortiert und Antworten vorbereitet.',
  'UC-KNOW': 'Mitarbeitende fragen interne Dokumente wie in einem Chat ab.',
  'UC-QA': 'Prüfprotokolle werden automatisch ausgewertet und Abweichungen markiert.',
  'UC-ORDER': 'Bestellungen aus PDFs landen ohne Abtippen im ERP.',
  'UC-REPORT': 'Berichte und Kennzahlen werden automatisch zusammengefasst.',
  'UC-SERVICE': 'Serviceanfragen werden vorqualifiziert und richtig zugeteilt.',
  'UC-TENDER': 'Ausschreibungen und Pläne werden schneller geprüft.',
  'UC-HR': 'Bewerbungen und Personaladministration werden entlastet.',
};
