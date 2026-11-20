/**
 * «2–3 passende Use Cases» for the cheat sheet (INTENT 6.2): keyword match on the KI-Bewertung (Einstieg, Stichworte,
 * Details) plus industry defaults. Only a suggestion for the conversation – nothing is written anywhere.
 */
import { USE_CASES, type CampaignMail, type Lead } from '@sales-portal/shared';

const KEYWORDS: Record<string, RegExp> = {
  'UC-DOC': /(beleg|rechnung|kreditor|buchhalt|treuhand|spesen)/i,
  'UC-OFFER': /(offert|angebot|kalkulation|preis)/i,
  'UC-MAIL': /(e-?mail|posteingang|anfragen|korrespondenz)/i,
  'UC-KNOW': /(wissen|dokument|handbuch|norm|vorschrift|intranet)/i,
  'UC-QA': /(qualität|qualitaet|prüf|pruef|protokoll|zertifi|iso)/i,
  'UC-ORDER': /(bestell|auftrag|erp|pdf|lieferschein)/i,
  'UC-REPORT': /(bericht|kennzahl|report|controlling|auswertung)/i,
  'UC-SERVICE': /(service|support|reklamation|ticket|kundendienst)/i,
  'UC-TENDER': /(ausschreibung|submission|plan|baugesuch|devis)/i,
  'UC-HR': /(bewerb|personal|rekrut|lohn|hr\b)/i,
};

const INDUSTRY_DEFAULTS: Record<string, string[]> = {
  Bau: ['UC-TENDER', 'UC-OFFER'],
  Holzbau: ['UC-TENDER', 'UC-OFFER'],
  Metallbau: ['UC-OFFER', 'UC-ORDER'],
  Maschinenbau: ['UC-OFFER', 'UC-QA'],
  'Elektro/Elektronik-Fertigung': ['UC-QA', 'UC-ORDER'],
  Medizintechnik: ['UC-QA', 'UC-KNOW'],
  Kunststoff: ['UC-QA', 'UC-ORDER'],
  Chemie: ['UC-QA', 'UC-KNOW'],
  Grosshandel: ['UC-ORDER', 'UC-MAIL'],
  Detailhandel: ['UC-SERVICE', 'UC-MAIL'],
  Logistik: ['UC-ORDER', 'UC-DOC'],
  Lebensmittel: ['UC-QA', 'UC-ORDER'],
  Treuhand: ['UC-DOC', 'UC-MAIL'],
  Immobilien: ['UC-MAIL', 'UC-DOC'],
  'Öffentliche Hand': ['UC-KNOW', 'UC-MAIL'],
  Gesundheitswesen: ['UC-KNOW', 'UC-HR'],
  'Druck und Medien': ['UC-OFFER', 'UC-ORDER'],
  Energie: ['UC-REPORT', 'UC-SERVICE'],
};

export interface UseCaseSuggestion {
  id: string;
  label: string;
  /** Why it fits (shown small under the use case). */
  why: string;
}

export function suggestUseCases(lead: Pick<Lead, 'kls_ki_bewertung' | 'assessment' | 'kls_industry' | 'kls_custom_industry'>, campaignMails: CampaignMail[] = [], max = 3): UseCaseSuggestion[] {
  const text = [lead.assessment?.einstieg, ...(lead.assessment?.stichworte ?? []), lead.assessment?.naechsterSchritt, ...(lead.assessment?.details ?? []), lead.kls_custom_industry]
    .filter(Boolean)
    .join(' ');
  const out: UseCaseSuggestion[] = [];
  const add = (id: string, why: string) => {
    if (out.length >= max || out.some((u) => u.id === id)) return;
    const uc = USE_CASES.find((u) => u.id === id);
    if (uc) out.push({ id, label: uc.label, why });
  };
  for (const [id, re] of Object.entries(KEYWORDS)) {
    const m = text.match(re);
    if (m) add(id, `KI-Bewertung erwähnt «${m[0]}»`);
  }
  for (const id of INDUSTRY_DEFAULTS[lead.kls_industry ?? ''] ?? []) add(id, `typisch für ${lead.kls_industry}`);
  // Already pushed in campaign mails: knüpfen statt wiederholen.
  for (const m of campaignMails) for (const id of m.useCaseIds) add(id, `aus Kampagnen-Mail «${m.subject}»`);
  if (!out.length) add('UC-DOC', 'häufigster Einstieg');
  return out;
}
