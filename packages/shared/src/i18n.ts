/**
 * Display texts for CRM codes (option sets) in plain Swiss German (no «ß»), plus grade / band / role helpers.
 *
 * Codes marked `assumed: true` are NOT confirmed by the Prod metadata of 17.11.2026 quoted in INTENT 6.5. They are
 * placeholders for the mock CRM and must be verified against the sandbox metadata before going live
 * (the live adapter maps by code, so only this file needs adjusting).
 */
import type { ContactRole, EmployeeBand, Grade, OrgType, ResultGroupKey, Role } from './types';

export interface OptionDef {
  code: number;
  /** Everyday wording for Markus (INTENT 6.0). */
  label: string;
  /** Original CRM label (shown to admins together with the code). */
  crmLabel?: string;
  assumed?: boolean;
  /** Option is deprecated / not used anymore (INTENT 6.5 «Nicht verwendet»). */
  deprecated?: boolean;
}

export type OptionSetName =
  | 'kls_callstatus'
  | 'kls_rating_category'
  | 'statuscode'
  | 'statecode'
  | 'kls_lead_support'
  | 'kls_interests'
  | 'kls_anrufergebnis'
  | 'kls_interesse'
  | 'leadsourcecode'
  | 'kls_salutation';

// ---------------------------------------------------------------------------------------------------------------------
// Option sets
// ---------------------------------------------------------------------------------------------------------------------

export const CALL_STATUS = {
  NOT_REACHED: 845140001,
  CALLBACK_TODAY: 845140002,
  CALLBACK_TOMORROW: 845140003,
  CALLBACK_7_DAYS: 845140004,
  CALLBACK_31_DAYS: 845140005,
  MEETING_BOOKED: 845140006,
  DO_NOT_CONTACT: 845140007,
  WAITING: 845140008,
  MEETING_PROPOSED: 845140009,
  CALLBACK_3_6_MONTHS: 845140010,
} as const;

export const RATING = {
  POTENTIAL: 845140004,
  LATER: 845140005,
  NO_NEED_PARTNER: 845140006,
  TOO_SMALL: 845140007,
  NO_NEED_INTERNAL: 845140008,
  DEPRECATED_9: 845140009,
  NO_NEED_CURRENT: 845140010,
} as const;

/** Lead statecode. */
export const STATE = { OPEN: 0, QUALIFIED: 1, DISQUALIFIED: 2 } as const;

/** Lead statuscode (Dataverse defaults 1–7 + custom 8451400xx). */
export const STATUS = {
  NEW: 1,
  CONTACTED: 2,
  QUALIFIED: 3,
  LOST: 4,
  CANNOT_CONTACT: 5,
  NO_LONGER_INTERESTED: 6,
  CANCELED: 7,
  EXCHANGE: 845140001,
  SECOND_CONTACT: 845140002,
  OUTSIDE_ICP: 845140003,
  SAME_DOMAIN_IN_PROGRESS: 845140004,
  EXISTING_ACCOUNT: 845140005,
} as const;

export const LEAD_SUPPORT = {
  MARKETING: 845140000,
  DIVENDO_COLDCALL: 845140001,
  BC_NAV_RESEARCH: 845140002,
  CAMPAIGN: 845140003,
  SALES: 845140004,
  COLDCALL: 845140005,
} as const;

export const INTEREST_KI_SERVICES = 845140014;

export const OPTION_SETS: Record<OptionSetName, OptionDef[]> = {
  kls_callstatus: [
    { code: 845140001, label: 'Nicht erreicht', crmLabel: 'Nicht erreicht' },
    { code: 845140002, label: 'Rückruf heute', crmLabel: 'Rückruf heute' },
    { code: 845140003, label: 'Rückruf morgen', crmLabel: 'Rückruf morgen' },
    { code: 845140004, label: 'Rückruf diese Woche', crmLabel: 'Rückruf in 7 Tagen' },
    { code: 845140005, label: 'Rückruf in den nächsten Wochen', crmLabel: 'Rückruf in 31 Tagen' },
    { code: 845140006, label: 'Termin vereinbart', crmLabel: 'Termin vereinbart' },
    { code: 845140007, label: 'Nicht mehr kontaktieren', crmLabel: 'Nicht mehr kontaktieren' },
    { code: 845140008, label: 'Wartet / Ansprechperson informiert', crmLabel: 'Wartet auf Rückmeldung' },
    { code: 845140009, label: 'Termin vorgeschlagen', crmLabel: 'Termin vorgeschlagen' },
    { code: 845140010, label: 'Rückruf in 3–6 Monaten', crmLabel: 'Rückruf in 3-6 Monaten' },
  ],
  kls_rating_category: [
    { code: 845140004, label: 'Potenzial vorhanden', crmLabel: 'Potenzial vorhanden' },
    { code: 845140005, label: 'Später wieder melden', crmLabel: 'Später wieder melden' },
    { code: 845140006, label: 'Kein Bedarf – hat Partner', crmLabel: 'Kein Bedarf - hat Partner' },
    { code: 845140007, label: 'Passt nicht (zu klein)', crmLabel: 'Passt nicht (zu klein)' },
    { code: 845140008, label: 'Kein Bedarf – intern / Konzern', crmLabel: 'Kein Bedarf - intern / Konzern' },
    { code: 845140009, label: 'veraltet', crmLabel: '(veraltet)', deprecated: true },
    { code: 845140010, label: 'Kein Bedarf (aktuell)', crmLabel: 'Kein Bedarf (aktuell)' },
  ],
  statecode: [
    { code: 0, label: 'Offen', crmLabel: 'Open' },
    { code: 1, label: 'Qualifiziert', crmLabel: 'Qualified' },
    { code: 2, label: 'Disqualifiziert', crmLabel: 'Disqualified' },
  ],
  statuscode: [
    { code: 1, label: 'Neu', crmLabel: 'Neu' },
    { code: 2, label: 'Kontaktiert', crmLabel: 'Kontaktiert' },
    { code: 3, label: 'Qualifiziert', crmLabel: 'Qualifiziert' },
    { code: 4, label: 'Verloren', crmLabel: 'Verloren' },
    { code: 5, label: 'Kontakt nicht möglich', crmLabel: 'Kontakt nicht möglich' },
    { code: 6, label: 'Nicht mehr interessiert', crmLabel: 'Nicht mehr interessiert' },
    { code: 7, label: 'Abgebrochen', crmLabel: 'Abgebrochen' },
    { code: 845140001, label: 'Austausch', crmLabel: 'Austausch', assumed: true },
    { code: 845140002, label: 'Zweitkontakt', crmLabel: 'Zweitkontakt', assumed: true },
    { code: 845140003, label: 'Ausserhalb ICP', crmLabel: 'Ausserhalb ICP' },
    { code: 845140004, label: 'Gleiche Domain in Bearbeitung', crmLabel: 'Gleiche Domain in Bearbeitung', assumed: true },
    { code: 845140005, label: 'Bestehende Firma im CRM', crmLabel: 'Bestehende Firma', assumed: true },
  ],
  kls_lead_support: [
    { code: 845140000, label: 'Marketing', assumed: true },
    { code: 845140001, label: 'Divendo-Coldcall', assumed: true },
    { code: 845140002, label: 'BC/NAV-Research', assumed: true },
    { code: 845140003, label: 'Automatisierte Kampagne', assumed: true },
    { code: 845140004, label: 'Verkauf', crmLabel: 'Verkauf' },
    { code: 845140005, label: 'Coldcall', assumed: true },
  ],
  kls_interests: [
    { code: 845140000, label: 'ERP Business Central', assumed: true },
    { code: 845140001, label: 'ERP NAV / Upgrade', assumed: true },
    { code: 845140002, label: 'CRM Dynamics 365', assumed: true },
    { code: 845140003, label: 'Power Platform', assumed: true },
    { code: 845140004, label: 'Microsoft 365 / Teams', assumed: true },
    { code: 845140005, label: 'Reporting / Power BI', assumed: true },
    { code: 845140006, label: 'Schnittstellen / Integration', assumed: true },
    { code: 845140014, label: 'KI-Dienstleistungen', crmLabel: 'KI-Dienstleistungen' },
  ],
  // kls_anrufergebnis is a new field (FixCRMSolution): one value per result group. Codes are portal proposals.
  kls_anrufergebnis: [
    { code: 845140000, label: 'Nicht erreicht', assumed: true },
    { code: 845140001, label: 'Rückruf vereinbart', assumed: true },
    { code: 845140002, label: 'Wartet / Ansprechperson informiert', assumed: true },
    { code: 845140003, label: 'Termin gebucht', assumed: true },
    { code: 845140004, label: '3 Vorschläge gesendet', assumed: true },
    { code: 845140005, label: 'Mail mit Infos gewünscht', assumed: true },
    { code: 845140006, label: 'Später wieder melden', assumed: true },
    { code: 845140007, label: 'Kein Bedarf (aktuell)', assumed: true },
    { code: 845140008, label: 'Hat Partner', assumed: true },
    { code: 845140009, label: 'Intern / Konzern', assumed: true },
    { code: 845140010, label: 'Zu klein (unter 5 MA)', assumed: true },
    { code: 845140011, label: 'Nicht mehr kontaktieren', assumed: true },
    { code: 845140012, label: 'Mitbewerber / IT-Dienstleister', assumed: true },
    { code: 845140013, label: 'Person nicht mehr in der Firma / falsche Person', assumed: true },
    { code: 845140014, label: 'Falsche Nummer', assumed: true },
  ],
  kls_interesse: [
    { code: 0, label: 'kein Interesse' },
    { code: 1, label: 'schwach' },
    { code: 2, label: 'offen' },
    { code: 3, label: 'klar' },
  ],
  leadsourcecode: [
    { code: 1, label: 'Inserat', crmLabel: 'Advertisement' },
    { code: 2, label: 'Empfehlung Mitarbeitende', crmLabel: 'Employee Referral' },
    { code: 3, label: 'Externe Empfehlung', crmLabel: 'External Referral' },
    { code: 4, label: 'Partner', crmLabel: 'Partner' },
    { code: 6, label: 'Messe / Seminar', crmLabel: 'Seminar' },
    { code: 8, label: 'Website', crmLabel: 'Web' },
    { code: 10, label: 'Sonstiges', crmLabel: 'Other' },
    { code: 845140000, label: 'Zefix', crmLabel: 'Zefix', assumed: true },
    { code: 845140001, label: 'Apollo', crmLabel: 'Apollo', assumed: true },
  ],
  kls_salutation: [
    { code: 845140000, label: 'Herr', assumed: true },
    { code: 845140001, label: 'Frau', assumed: true },
  ],
};

/** kls_anrufergebnis code per result group (same order as the INTENT 6.5 table). */
export const RESULT_GROUP_CODES: Record<ResultGroupKey, number> = {
  not_reached: 845140000,
  callback: 845140001,
  waiting: 845140002,
  meeting_booked: 845140003,
  proposals_sent: 845140004,
  info_mail: 845140005,
  later: 845140006,
  no_need: 845140007,
  has_partner: 845140008,
  internal_group: 845140009,
  too_small: 845140010,
  do_not_contact: 845140011,
  competitor: 845140012,
  wrong_person: 845140013,
  wrong_number: 845140014,
};

export const RESULT_GROUP_LABELS: Record<ResultGroupKey, string> = {
  not_reached: 'Nicht erreicht',
  callback: 'Rückruf vereinbart',
  waiting: 'Wartet / Ansprechperson informiert',
  meeting_booked: 'Termin gebucht',
  proposals_sent: '3 Vorschläge gesendet',
  info_mail: 'Mail mit Infos gewünscht',
  later: 'Später wieder melden',
  no_need: 'Kein Bedarf (aktuell)',
  has_partner: 'Hat Partner',
  internal_group: 'Intern / Konzern',
  too_small: 'Zu klein (unter 5 MA)',
  do_not_contact: 'Nicht mehr kontaktieren',
  competitor: 'Mitbewerber / IT-Dienstleister',
  wrong_person: 'Person nicht mehr in der Firma / falsche Person',
  wrong_number: 'Falsche Nummer',
};

/** Results that mean «nobody was reached» (INTENT 5 real contact). */
export const NOT_REACHED_RESULT_CODES: number[] = [RESULT_GROUP_CODES.not_reached, RESULT_GROUP_CODES.wrong_number];

export function resultGroupByCode(code: number | null | undefined): ResultGroupKey | null {
  if (code == null) return null;
  const entry = (Object.entries(RESULT_GROUP_CODES) as [ResultGroupKey, number][]).find(([, c]) => c === code);
  return entry ? entry[0] : null;
}

const optionIndex = new Map<OptionSetName, Map<number, OptionDef>>(
  (Object.keys(OPTION_SETS) as OptionSetName[]).map((name) => [name, new Map(OPTION_SETS[name].map((o) => [o.code, o]))]),
);

/** Label for an option-set code; unknown codes are shown as «Wert <code>» (never throws). */
export function optionLabel(set: OptionSetName, code: number | null | undefined): string | null {
  if (code == null) return null;
  return optionIndex.get(set)?.get(code)?.label ?? `Wert ${code}`;
}

export function optionDef(set: OptionSetName, code: number): OptionDef | undefined {
  return optionIndex.get(set)?.get(code);
}

/** Admin view: «Rückruf heute (845140002)». */
export function optionLabelWithCode(set: OptionSetName, code: number | null | undefined): string | null {
  const label = optionLabel(set, code);
  return label == null ? null : `${label} (${code})`;
}

export function multiOptionLabels(set: OptionSetName, codes: number[] | null | undefined): string[] {
  return (codes ?? []).map((c) => optionLabel(set, c) ?? String(c));
}

// ---------------------------------------------------------------------------------------------------------------------
// Grade
// ---------------------------------------------------------------------------------------------------------------------

export function gradeFromScore(score: number | null | undefined): Grade {
  if (score == null || Number.isNaN(score)) return 'unrated';
  if (score >= 70) return 'A';
  if (score >= 50) return 'B';
  if (score >= 30) return 'C';
  return 'D';
}

export const GRADE_LABELS: Record<Grade, string> = {
  A: 'A',
  B: 'B',
  C: 'C',
  D: 'D',
  unrated: 'unbewertet',
};

/** Score range per grade (inclusive min, exclusive max) – for filters. */
export const GRADE_SCORE_RANGES: Record<Exclude<Grade, 'unrated'>, { min: number; max: number }> = {
  A: { min: 70, max: Number.POSITIVE_INFINITY },
  B: { min: 50, max: 70 },
  C: { min: 30, max: 50 },
  D: { min: Number.NEGATIVE_INFINITY, max: 30 },
};

// ---------------------------------------------------------------------------------------------------------------------
// Employee bands (INTENT 6.1)
// ---------------------------------------------------------------------------------------------------------------------

export const EMPLOYEE_BANDS: { key: EmployeeBand; label: string; min: number | null; max: number | null }[] = [
  { key: '1-4', label: '1–4', min: 1, max: 4 },
  { key: '5-9', label: '5–9', min: 5, max: 9 },
  { key: '10-19', label: '10–19', min: 10, max: 19 },
  { key: '20-49', label: '20–49', min: 20, max: 49 },
  { key: '50-249', label: '50–249', min: 50, max: 249 },
  { key: '250-999', label: '250–999', min: 250, max: 999 },
  { key: '1000+', label: "1'000+", min: 1000, max: null },
  { key: 'unknown', label: 'unbekannt', min: null, max: null },
];

export function employeeBand(count: number | null | undefined): EmployeeBand {
  if (count == null || Number.isNaN(count) || count <= 0) return 'unknown';
  if (count < 5) return '1-4';
  if (count < 10) return '5-9';
  if (count < 20) return '10-19';
  if (count < 50) return '20-49';
  if (count < 250) return '50-249';
  if (count < 1000) return '250-999';
  return '1000+';
}

export function employeeBandLabel(band: EmployeeBand): string {
  return EMPLOYEE_BANDS.find((b) => b.key === band)?.label ?? band;
}

// ---------------------------------------------------------------------------------------------------------------------
// Roles, org types, contact roles
// ---------------------------------------------------------------------------------------------------------------------

export const ROLE_LABELS: Record<Role, string> = {
  coldcaller: 'Coldcaller',
  sales: 'Sales',
  ai_specialist: 'AI-Spezialist',
  admin: 'Admin',
};

export const ORG_TYPE_LABELS: Record<OrgType, string> = {
  private: 'privat',
  public: 'öffentliche Hand',
  association: 'Verein / Stiftung',
  unknown: 'unbekannt',
};

export const CONTACT_ROLE_LABELS: Record<ContactRole, string> = {
  management: 'Geschäftsleitung',
  it: 'IT',
  finance_operations: 'Finanzen / Betrieb',
  sales_marketing: 'Verkauf / Marketing',
  production: 'Produktion / Technik',
  other: 'andere Funktion',
  unknown: 'unbekannt',
};

/** Classify a job title (German/English) into a contact role («Rolle der Ansprechperson», INTENT 6.1). */
export function classifyJobTitle(jobtitle: string | null | undefined): ContactRole {
  if (!jobtitle || !jobtitle.trim()) return 'unknown';
  const t = jobtitle.toLowerCase();
  if (/(geschäftsf|geschaeftsf|gesch\.?f|ceo|inhaber|owner|geschäftsleit|gl\b|direktor|director|präsident|president|managing|partner|verwaltungsrat|gemeindeschreiber|stadtschreiber)/.test(t))
    return 'management';
  if (/(\bit\b|informatik|cio|cto|digital|system|ict|edv|software|data)/.test(t)) return 'it';
  if (/(finanz|cfo|controll|buchhalt|treuhand|betrieb|coo|operations|administration|personal|hr\b|einkauf|logistik)/.test(t))
    return 'finance_operations';
  if (/(verkauf|vertrieb|sales|marketing|kunden|key account)/.test(t)) return 'sales_marketing';
  if (/(produktion|technik|technischer|engineering|werkstatt|qualität|qualitaet|entwicklung|leiter bau|bauleit)/.test(t))
    return 'production';
  return 'other';
}

/** Swiss cantons (abbreviation → name) for region filters. */
export const CANTONS: Record<string, string> = {
  AG: 'Aargau',
  AI: 'Appenzell Innerrhoden',
  AR: 'Appenzell Ausserrhoden',
  BE: 'Bern',
  BL: 'Basel-Landschaft',
  BS: 'Basel-Stadt',
  FR: 'Freiburg',
  GE: 'Genf',
  GL: 'Glarus',
  GR: 'Graubünden',
  JU: 'Jura',
  LU: 'Luzern',
  NE: 'Neuenburg',
  NW: 'Nidwalden',
  OW: 'Obwalden',
  SG: 'St. Gallen',
  SH: 'Schaffhausen',
  SO: 'Solothurn',
  SZ: 'Schwyz',
  TG: 'Thurgau',
  TI: 'Tessin',
  UR: 'Uri',
  VD: 'Waadt',
  VS: 'Wallis',
  ZG: 'Zug',
  ZH: 'Zürich',
};

// ---------------------------------------------------------------------------------------------------------------------
// Use-case catalog (campaign mails, analysis, briefing). Ids are stable keys (open question 6).
// ---------------------------------------------------------------------------------------------------------------------

export const USE_CASES: { id: string; label: string; short: string }[] = [
  { id: 'UC-DOC', label: 'Belege und Rechnungen automatisch erfassen', short: 'Belegerfassung' },
  { id: 'UC-OFFER', label: 'Offerten schneller erstellen', short: 'Offerten' },
  { id: 'UC-MAIL', label: 'E-Mail-Eingang sortieren und beantworten', short: 'Mail-Eingang' },
  { id: 'UC-KNOW', label: 'Wissen aus Dokumenten abfragen (interner Chat)', short: 'Wissens-Chat' },
  { id: 'UC-QA', label: 'Prüfprotokolle und Qualitätsberichte auswerten', short: 'Qualität' },
  { id: 'UC-ORDER', label: 'Bestellungen aus PDFs ins ERP übernehmen', short: 'Bestellungen' },
  { id: 'UC-REPORT', label: 'Berichte und Kennzahlen automatisch zusammenfassen', short: 'Reporting' },
  { id: 'UC-SERVICE', label: 'Serviceanfragen vorqualifizieren', short: 'Service' },
  { id: 'UC-TENDER', label: 'Ausschreibungen und Pläne schneller prüfen', short: 'Ausschreibungen' },
  { id: 'UC-HR', label: 'Bewerbungen und Personaladministration entlasten', short: 'Personal' },
];

export function useCaseLabel(id: string): string {
  return USE_CASES.find((u) => u.id === id)?.label ?? id;
}

/** Industries (subset of the 147 kls_industry values) used by the mock CRM and filter suggestions. */
export const INDUSTRIES = [
  'Bau',
  'Maschinenbau',
  'Elektro/Elektronik-Fertigung',
  'Grosshandel',
  'Chemie',
  'Öffentliche Hand',
  'Metallbau',
  'Lebensmittel',
  'Logistik',
  'Medizintechnik',
  'Treuhand',
  'Immobilien',
  'Detailhandel',
  'Gesundheitswesen',
  'Kunststoff',
  'Holzbau',
  'Druck und Medien',
  'Energie',
] as const;

export const CALL_CATEGORY_LABELS = {
  outbound: 'ausgehend',
  callback_answered: 'Rückruf angenommen',
  callback_missed: 'Rückruf verpasst',
  unknown_number: 'unbekannte Nummer',
} as const;

export const CALL_PHASE_LABELS = {
  idle: 'bereit',
  dialing: 'wählt',
  connected: 'im Gespräch',
  wrapup: 'Nachbearbeitung',
} as const;
