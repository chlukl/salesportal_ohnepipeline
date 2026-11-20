/**
 * Templates (Betreff, Einladung, Mails, Briefing): placeholder catalogue and validation. Plain text only – the
 * placeholders are replaced as text by the modules that send mails / create events.
 */
import type { TemplateKind } from '@sales-portal/shared';
import { HTML_TAG_RE } from './ruleSchema';

export interface PlaceholderDef {
  name: string;
  help: string;
}

const P = {
  Firma: 'Firmenname des Leads',
  Anrede: '«Herr» / «Frau» (wenn bekannt)',
  Vorname: 'Vorname der Ansprechperson',
  Nachname: 'Nachname der Ansprechperson',
  Absender: 'Name der Person, die sendet',
  Datum: 'Datum des Termins (TT.MM.JJJJ)',
  Uhrzeit: 'Startzeit des Termins (HH:MM)',
  Sales: 'gebuchter Sales',
  Spezialist: 'AI-Spezialist im Termin',
  Vorschlaege: 'die 3 Terminvorschläge als Liste',
  UseCase: 'wichtigster Use Case (Kurzname)',
  UseCases: '1–2 passende Use Cases mit Nutzen',
  Einleitung: 'Einstieg mit Bezug zum Gespräch',
  Einstieg: 'Einstieg aus der KI-Bewertung',
  Terminangebot: 'Terminangebot (optional mit Vorschlägen)',
  Kampagne: 'Hinweis auf Kampagnen-Mails (nur bei Terminen aus der Kampagne)',
  Profil: 'Kurzprofil der Firma',
  Kontakt: 'Ansprechperson und Rolle',
  Verlauf: 'Coldcall-Zusammenfassung und frühere Kontakte',
  Fragen: 'Einstiegsfragen',
  OffenePunkte: 'offene Punkte',
  Vorbereitung: 'was vorzubereiten ist',
} as const;

type Name = keyof typeof P;

const BY_KIND: Record<TemplateKind, Name[]> = {
  subject: ['Firma'],
  invitation: ['Firma', 'Anrede', 'Vorname', 'Nachname', 'Datum', 'Uhrzeit', 'Sales', 'Spezialist', 'Absender'],
  proposals: ['Firma', 'Anrede', 'Vorname', 'Nachname', 'Vorschlaege', 'Absender'],
  mail: ['Firma', 'Anrede', 'Vorname', 'Nachname', 'UseCase', 'UseCases', 'Einleitung', 'Einstieg', 'Terminangebot', 'Absender'],
  briefing: ['Firma', 'Datum', 'Uhrzeit', 'Kampagne', 'Profil', 'Kontakt', 'Verlauf', 'UseCases', 'Fragen', 'OffenePunkte', 'Vorbereitung', 'Sales', 'Spezialist'],
};

export function placeholdersFor(kind: TemplateKind): PlaceholderDef[] {
  return BY_KIND[kind].map((name) => ({ name, help: P[name] }));
}

/** `{Firma}` → ['Firma']. */
export function usedPlaceholders(text: string): string[] {
  return [...text.matchAll(/\{([^{}\n]*)\}/g)].map((m) => m[1]);
}

/** Returns German problems (empty = valid). */
export function validateTemplateText(kind: TemplateKind, parts: { subject?: string | null; body: string }): string[] {
  const problems: string[] = [];
  const allowed = new Set<string>(BY_KIND[kind]);
  for (const [label, text] of [
    ['Betreff', parts.subject ?? ''],
    ['Text', parts.body],
  ] as const) {
    if (HTML_TAG_RE.test(text)) problems.push(`${label}: bitte nur Text – keine HTML-Tags`);
    const unknown = [...new Set(usedPlaceholders(text).filter((p) => !allowed.has(p)))];
    if (unknown.length) problems.push(`${label}: unbekannte Platzhalter ${unknown.map((u) => `{${u}}`).join(', ')}`);
    const open = (text.match(/\{/g) ?? []).length;
    const close = (text.match(/\}/g) ?? []).length;
    if (open !== close) problems.push(`${label}: geschweifte Klammern sind nicht vollständig`);
  }
  if (!parts.body.trim()) problems.push('Text fehlt');
  return problems;
}
