/** Static word lists for the invented demo CRM (German-speaking Switzerland). All companies and persons are fictional. */

export interface Town {
  city: string;
  plz: string;
  canton: string;
  /** Swiss area code without leading 0. */
  area: string;
}

export const TOWNS: Town[] = [
  { city: 'Basel', plz: '4051', canton: 'BS', area: '61' },
  { city: 'Basel', plz: '4057', canton: 'BS', area: '61' },
  { city: 'Liestal', plz: '4410', canton: 'BL', area: '61' },
  { city: 'Pratteln', plz: '4133', canton: 'BL', area: '61' },
  { city: 'Allschwil', plz: '4123', canton: 'BL', area: '61' },
  { city: 'Muttenz', plz: '4132', canton: 'BL', area: '61' },
  { city: 'Aarau', plz: '5000', canton: 'AG', area: '62' },
  { city: 'Baden', plz: '5400', canton: 'AG', area: '56' },
  { city: 'Brugg', plz: '5200', canton: 'AG', area: '56' },
  { city: 'Wettingen', plz: '5430', canton: 'AG', area: '56' },
  { city: 'Lenzburg', plz: '5600', canton: 'AG', area: '62' },
  { city: 'Rheinfelden', plz: '4310', canton: 'AG', area: '61' },
  { city: 'Zürich', plz: '8005', canton: 'ZH', area: '44' },
  { city: 'Zürich', plz: '8048', canton: 'ZH', area: '44' },
  { city: 'Winterthur', plz: '8400', canton: 'ZH', area: '52' },
  { city: 'Uster', plz: '8610', canton: 'ZH', area: '44' },
  { city: 'Dübendorf', plz: '8600', canton: 'ZH', area: '44' },
  { city: 'Bülach', plz: '8180', canton: 'ZH', area: '44' },
  { city: 'Wädenswil', plz: '8820', canton: 'ZH', area: '44' },
  { city: 'Luzern', plz: '6003', canton: 'LU', area: '41' },
  { city: 'Emmen', plz: '6020', canton: 'LU', area: '41' },
  { city: 'Sursee', plz: '6210', canton: 'LU', area: '41' },
  { city: 'Zug', plz: '6300', canton: 'ZG', area: '41' },
  { city: 'Baar', plz: '6340', canton: 'ZG', area: '41' },
  { city: 'St. Gallen', plz: '9000', canton: 'SG', area: '71' },
  { city: 'Wil', plz: '9500', canton: 'SG', area: '71' },
  { city: 'Rapperswil-Jona', plz: '8640', canton: 'SG', area: '55' },
  { city: 'Bern', plz: '3011', canton: 'BE', area: '31' },
  { city: 'Thun', plz: '3600', canton: 'BE', area: '33' },
  { city: 'Biel/Bienne', plz: '2502', canton: 'BE', area: '32' },
  { city: 'Burgdorf', plz: '3400', canton: 'BE', area: '34' },
  { city: 'Langenthal', plz: '4900', canton: 'BE', area: '62' },
  { city: 'Solothurn', plz: '4500', canton: 'SO', area: '32' },
  { city: 'Olten', plz: '4600', canton: 'SO', area: '62' },
  { city: 'Grenchen', plz: '2540', canton: 'SO', area: '32' },
  { city: 'Frauenfeld', plz: '8500', canton: 'TG', area: '52' },
  { city: 'Weinfelden', plz: '8570', canton: 'TG', area: '71' },
  { city: 'Schaffhausen', plz: '8200', canton: 'SH', area: '52' },
  { city: 'Chur', plz: '7000', canton: 'GR', area: '81' },
  { city: 'Schwyz', plz: '6430', canton: 'SZ', area: '41' },
  { city: 'Lachen', plz: '8853', canton: 'SZ', area: '55' },
  { city: 'Stans', plz: '6370', canton: 'NW', area: '41' },
  { city: 'Glarus', plz: '8750', canton: 'GL', area: '55' },
  { city: 'Herisau', plz: '9100', canton: 'AR', area: '71' },
  { city: 'Fribourg', plz: '1700', canton: 'FR', area: '26' },
];

export const SURNAMES = [
  'Müller', 'Meier', 'Schmid', 'Keller', 'Weber', 'Huber', 'Schneider', 'Meyer', 'Steiner', 'Fischer', 'Gerber', 'Brunner',
  'Baumann', 'Frei', 'Zimmermann', 'Moser', 'Widmer', 'Wyss', 'Graf', 'Roth', 'Bühler', 'Suter', 'Kunz', 'Lüthi', 'Marti',
  'Hofer', 'Bachmann', 'Kaufmann', 'Wenger', 'Christen', 'Sutter', 'Imhof', 'Egli', 'Bieri', 'Stucki', 'Ammann', 'Zürcher',
  'Hess', 'Vogel', 'Blaser', 'Bucher', 'Kälin', 'Odermatt', 'Arnold', 'Lehmann', 'Rüegg', 'Furrer', 'Jost', 'Studer', 'Gisler',
  'Aebi', 'Hug', 'Wälti', 'Zaugg', 'Schürch', 'Frehner', 'Rohner', 'Tobler', 'Lustenberger', 'Infanger',
];

export const MALE_FIRST = [
  'Daniel', 'Thomas', 'Martin', 'Peter', 'Andreas', 'Stefan', 'Reto', 'Beat', 'Urs', 'Marco', 'Patrick', 'Christian',
  'Michael', 'Roger', 'Adrian', 'Simon', 'Fabian', 'Philipp', 'Roland', 'Matthias', 'Bruno', 'Jürg', 'René', 'Sandro',
];
export const FEMALE_FIRST = [
  'Sandra', 'Monika', 'Barbara', 'Nicole', 'Claudia', 'Andrea', 'Karin', 'Sabine', 'Corinne', 'Daniela', 'Esther',
  'Franziska', 'Martina', 'Regula', 'Simone', 'Jasmin', 'Melanie', 'Sarah', 'Laura', 'Nadine', 'Ursula', 'Priska',
];

export interface IndustryDef {
  industry: string | null;
  weight: number;
  orgType: 'private' | 'public' | 'association';
  /** Name patterns: {S} surname, {S2} second surname, {C} city, {W} word from `words`. */
  patterns: string[];
  words: string[];
  custom: string[];
  einstieg: string[];
  keywords: string[];
  useCases: string[];
  /** Typical employee bands for this industry (weights per band index of EMPLOYEE_BAND_WEIGHTS). */
  sizeBias?: number[];
}

export const INDUSTRIES: IndustryDef[] = [
  {
    industry: 'Bau',
    weight: 14,
    orgType: 'private',
    patterns: ['{S} Bau AG', '{S} + {S2} Bauunternehmung AG', '{C} Hochbau GmbH', '{S} Bedachungen AG', '{S} Gipser & Maler AG', '{S} Tiefbau AG'],
    words: [],
    custom: ['Hochbau', 'Tiefbau', 'Gebäudehülle', 'Ausbaugewerbe'],
    einstieg: [
      'Viele Ausmasse und Offerten entstehen von Hand – Einstieg über schnellere Offertenerstellung mit KI.',
      'Bauleiter verlieren Zeit mit Rapporten und Regieberichten – Einstieg über automatische Rapport-Auswertung.',
    ],
    keywords: ['Offerten', 'Ausmass', 'Regieberichte', 'Fachkräftemangel', 'Submissionen', 'Baustellenrapporte'],
    useCases: ['UC-OFFER', 'UC-TENDER', 'UC-REPORT'],
  },
  {
    industry: 'Maschinenbau',
    weight: 13,
    orgType: 'private',
    patterns: ['{S} Maschinenbau AG', '{S} Präzisionsmechanik AG', '{W} {S} AG', '{S} Engineering AG', '{C} Maschinenfabrik AG'],
    words: ['Fördertechnik', 'Antriebstechnik', 'Automation', 'Hydraulik', 'Sondermaschinen'],
    custom: ['Sondermaschinen', 'Präzisionsteile', 'Automation', 'Anlagenbau'],
    einstieg: [
      'Technische Dokumentation und Ersatzteilanfragen binden das Team – Einstieg über Wissens-Chat auf Basis der Handbücher.',
      'Serviceanfragen kommen unstrukturiert per Mail – Einstieg über KI-Vorqualifizierung im Service.',
    ],
    keywords: ['Ersatzteile', 'Handbücher', 'Service', 'Export', 'CAD', 'Variantenvielfalt'],
    useCases: ['UC-KNOW', 'UC-SERVICE', 'UC-OFFER'],
  },
  {
    industry: 'Elektro/Elektronik-Fertigung',
    weight: 10,
    orgType: 'private',
    patterns: ['{S} Elektronik AG', '{S} Electronic Systems AG', 'Elektro {S} AG', '{S} Leiterplatten AG', '{S} Kabelkonfektion GmbH', '{C} Steuerungsbau AG'],
    words: [],
    custom: ['Leiterplatten', 'Steuerungsbau', 'Elektroinstallation', 'Baugruppen'],
    einstieg: [
      'Prüfprotokolle aus der Fertigung werden manuell ausgewertet – Einstieg über automatische Qualitätsauswertung.',
      'Bestellungen von Kunden kommen als PDF – Einstieg über automatische Übernahme ins ERP.',
    ],
    keywords: ['Qualitätsprüfung', 'Prüfprotokolle', 'Stücklisten', 'Lieferketten', 'ISO 9001', 'Rückverfolgbarkeit'],
    useCases: ['UC-QA', 'UC-ORDER', 'UC-KNOW'],
  },
  {
    industry: 'Grosshandel',
    weight: 10,
    orgType: 'private',
    patterns: ['{S} Handels AG', '{S} Grosshandel AG', '{W} {S} AG', '{S} & Co. AG', '{C} Handelshaus AG'],
    words: ['Eisenwaren', 'Sanitärhandel', 'Getränke', 'Werkzeuge', 'Baustoffe', 'Agrarhandel'],
    custom: ['Technischer Handel', 'Baustoffhandel', 'Lebensmittelhandel'],
    einstieg: [
      'Bestellungen kommen als PDF und Mail – Einstieg über automatische Übernahme ins ERP.',
      'Der Innendienst beantwortet viele gleiche Anfragen – Einstieg über KI im Mail-Eingang.',
    ],
    keywords: ['Bestellungen', 'Innendienst', 'Lieferscheine', 'Preislisten', 'Webshop', 'Lager'],
    useCases: ['UC-ORDER', 'UC-MAIL', 'UC-DOC'],
  },
  {
    industry: 'Chemie',
    weight: 6,
    orgType: 'private',
    patterns: ['{S} Chemie AG', '{C} Chemicals AG', '{S} Lacke & Farben AG', '{S} Reinigungstechnik AG'],
    words: [],
    custom: ['Spezialchemie', 'Farben und Lacke', 'Reinigungsmittel'],
    einstieg: [
      'Sicherheitsdatenblätter und Kundenanfragen kosten Zeit – Einstieg über Dokumenten-Chat.',
      'Rezepturen und Prüfberichte liegen verstreut – Einstieg über Wissens-Chat für die Entwicklung.',
    ],
    keywords: ['Sicherheitsdatenblätter', 'REACH', 'Rezepturen', 'Labor', 'Zulassungen'],
    useCases: ['UC-KNOW', 'UC-DOC', 'UC-REPORT'],
  },
  {
    industry: 'Öffentliche Hand',
    weight: 8,
    orgType: 'public',
    patterns: ['Gemeinde {C}', 'Einwohnergemeinde {C}', 'Stadtverwaltung {C}', 'Werkbetriebe {C}', 'Zweckverband Abwasser {C}'],
    words: [],
    custom: ['Gemeindeverwaltung', 'Werke', 'Zweckverband'],
    einstieg: [
      'Viele Bürgeranfragen per Mail – Einstieg über Vorsortierung des Posteingangs.',
      'Protokolle und Berichte für Kommissionen entstehen von Hand – Einstieg über automatische Zusammenfassungen.',
    ],
    keywords: ['Bürgeranfragen', 'Protokolle', 'Datenschutz', 'Fachapplikationen', 'Gemeinderat'],
    useCases: ['UC-MAIL', 'UC-REPORT', 'UC-KNOW'],
  },
  {
    industry: 'Metallbau',
    weight: 6,
    orgType: 'private',
    patterns: ['{S} Metallbau AG', '{S} Stahlbau AG', '{S} Blechtechnik GmbH', '{C} Metall AG'],
    words: [],
    custom: ['Stahlbau', 'Blechbearbeitung', 'Fassaden'],
    einstieg: ['Offerten für Einzelanfertigungen dauern lange – Einstieg über KI-gestützte Offertenerstellung.'],
    keywords: ['Einzelanfertigung', 'Offerten', 'Pläne', 'Werkstatt'],
    useCases: ['UC-OFFER', 'UC-TENDER'],
  },
  {
    industry: 'Logistik',
    weight: 5,
    orgType: 'private',
    patterns: ['{S} Transporte AG', '{S} Logistik AG', '{C} Spedition AG'],
    words: [],
    custom: ['Transporte', 'Lagerlogistik', 'Spedition'],
    einstieg: ['Lieferscheine und Frachtpapiere werden abgetippt – Einstieg über automatische Belegerfassung.'],
    keywords: ['Frachtpapiere', 'Disposition', 'Zoll', 'Lieferscheine'],
    useCases: ['UC-DOC', 'UC-MAIL'],
  },
  {
    industry: 'Lebensmittel',
    weight: 4,
    orgType: 'private',
    patterns: ['{S} Bäckerei-Konditorei AG', '{C} Käserei AG', '{S} Feinkost AG', '{S} Getränke AG'],
    words: [],
    custom: ['Bäckerei', 'Molkerei', 'Getränke'],
    einstieg: ['Bestellungen der Filialen und Wiederverkäufer kommen über viele Kanäle – Einstieg über automatische Bestellerfassung.'],
    keywords: ['Filialen', 'Bestellungen', 'Lebensmittelsicherheit', 'Saisonalität'],
    useCases: ['UC-ORDER', 'UC-QA'],
  },
  {
    industry: 'Medizintechnik',
    weight: 4,
    orgType: 'private',
    patterns: ['{S} Medical AG', '{S} Medizintechnik AG', '{C} Medtech AG'],
    words: [],
    custom: ['Implantate', 'Medizinprodukte', 'Labortechnik'],
    einstieg: ['Dokumentation für die MDR bindet viel Zeit – Einstieg über Wissens-Chat und Berichtsentwürfe.'],
    keywords: ['MDR', 'Dokumentation', 'Qualitätsmanagement', 'Zulassung'],
    useCases: ['UC-KNOW', 'UC-QA', 'UC-REPORT'],
  },
  {
    industry: 'Treuhand',
    weight: 4,
    orgType: 'private',
    patterns: ['{S} Treuhand AG', '{S} + {S2} Treuhand GmbH', '{C} Revision AG'],
    words: [],
    custom: ['Treuhand', 'Revision', 'Lohnbuchhaltung'],
    einstieg: ['Belege der Mandanten werden von Hand erfasst – Einstieg über automatische Belegerfassung.'],
    keywords: ['Belege', 'Mandanten', 'Abschlüsse', 'Steuern'],
    useCases: ['UC-DOC', 'UC-MAIL'],
  },
  {
    industry: 'Holzbau',
    weight: 3,
    orgType: 'private',
    patterns: ['{S} Holzbau AG', '{S} Schreinerei AG', '{S} Zimmerei GmbH'],
    words: [],
    custom: ['Holzbau', 'Schreinerei', 'Innenausbau'],
    einstieg: ['Offerten und Arbeitsvorbereitung von Hand – Einstieg über schnellere Offerten.'],
    keywords: ['Offerten', 'Arbeitsvorbereitung', 'CNC', 'Elementbau'],
    useCases: ['UC-OFFER', 'UC-REPORT'],
  },
  {
    industry: 'Kunststoff',
    weight: 3,
    orgType: 'private',
    patterns: ['{S} Kunststofftechnik AG', '{S} Plastics AG', '{C} Spritzguss AG'],
    words: [],
    custom: ['Spritzguss', 'Kunststoffteile'],
    einstieg: ['Qualitätsberichte aus der Produktion werden manuell zusammengestellt – Einstieg über automatische Auswertung.'],
    keywords: ['Spritzguss', 'Qualität', 'Werkzeugbau', 'Automotive'],
    useCases: ['UC-QA', 'UC-REPORT'],
  },
  {
    industry: 'Gesundheitswesen',
    weight: 3,
    orgType: 'association',
    patterns: ['Stiftung Alterszentrum {C}', 'Spitex {C}', 'Verein Wohnheim {C}'],
    words: [],
    custom: ['Pflege', 'Spitex', 'Wohnheim'],
    einstieg: ['Pflegedokumentation und Berichte binden Fachpersonal – Einstieg über Berichtsentwürfe mit KI.'],
    keywords: ['Pflegedokumentation', 'Dienstplanung', 'Fachkräftemangel', 'Datenschutz'],
    useCases: ['UC-REPORT', 'UC-HR'],
  },
  {
    industry: 'Energie',
    weight: 2,
    orgType: 'public',
    patterns: ['Elektrizitätswerk {C}', 'Energie {C} AG', 'Wasserversorgung {C}'],
    words: [],
    custom: ['Energieversorger', 'Netzbetreiber'],
    einstieg: ['Kundenanfragen zu Anschlüssen und Rechnungen per Mail – Einstieg über Mail-Eingang mit KI.'],
    keywords: ['Kundendienst', 'Netzanschlüsse', 'Rechnungen', 'Regulierung'],
    useCases: ['UC-MAIL', 'UC-SERVICE'],
  },
  {
    industry: null,
    weight: 5,
    orgType: 'private',
    patterns: ['{S} AG', '{S} & Partner AG', '{C} Services GmbH', '{S} Group AG'],
    words: [],
    custom: [],
    einstieg: ['Branche noch unklar – Einstieg über allgemeinen Nutzen von KI im Büroalltag.'],
    keywords: ['Büroalltag', 'E-Mails', 'Dokumente'],
    useCases: ['UC-MAIL', 'UC-DOC'],
  },
];

/** Employee counts per band with weights (5 % 1–4, 12 % 5–9, 20 % 10–19, 25 % 20–49, 25 % 50–249, 6 % 250–999, 1 % 1'000+, 6 % unknown). */
export const EMPLOYEE_BAND_WEIGHTS: [[number, number] | null, number][] = [
  [[2, 4], 5],
  [[5, 9], 12],
  [[10, 19], 20],
  [[20, 49], 25],
  [[50, 249], 25],
  [[250, 999], 6],
  [[1000, 2400], 1],
  [null, 6],
];

export const JOB_TITLES_PRIVATE = {
  management: ['Geschäftsführer', 'Inhaber', 'CEO', 'Geschäftsleiter', 'Mitglied der Geschäftsleitung'],
  managementF: ['Geschäftsführerin', 'Inhaberin', 'CEO', 'Geschäftsleiterin'],
  other: ['Leiter Finanzen', 'CFO', 'Leiter Informatik', 'IT-Verantwortlicher', 'Leiter Betrieb', 'Produktionsleiter', 'Leiter Verkauf', 'COO'],
  otherF: ['Leiterin Finanzen', 'Leiterin Administration', 'IT-Verantwortliche', 'Leiterin Verkauf', 'Assistentin der Geschäftsleitung', 'Leiterin Personal'],
};
export const JOB_TITLES_PUBLIC = {
  management: ['Gemeindeschreiber', 'Stadtschreiber', 'Geschäftsführer', 'Leiter Werke'],
  managementF: ['Gemeindeschreiberin', 'Stadtschreiberin', 'Geschäftsführerin'],
  other: ['Leiter Informatik', 'Leiter Finanzen', 'Bauverwalter'],
  otherF: ['Leiterin Informatik', 'Leiterin Finanzen', 'Leiterin Einwohnerdienste'],
};

export const ERP_SYSTEMS = ['Abacus', 'SAP Business One', 'Business Central', 'Sage 200', 'Bexio', 'Opacc', 'Proffix', 'Navision'];

export const CALL_NOTES: Record<string, string[]> = {
  callback: [
    'GL war in einer Sitzung, Assistentin sagt: am {day} ab 10 Uhr erreichbar.',
    'Kurz gesprochen, passt gerade nicht. Rückruf vereinbart.',
    'Interesse grundsätzlich da, will zuerst intern mit IT sprechen. Rückruf vereinbart.',
  ],
  waiting: [
    'Hat die Infos an den Leiter Informatik weitergegeben, meldet sich.',
    'Ansprechperson ist in den Ferien, Stellvertretung informiert.',
  ],
  meeting_booked: [
    'Sehr offen, viele manuelle Abläufe bei Offerten. Termin mit Manuel und Nico gebucht.',
    'Hat schon mit ChatGPT experimentiert, will wissen, was sicher geht. Termin gebucht.',
  ],
  proposals_sent: ['Will Termin, muss Kalender prüfen. 3 Vorschläge per Mail gesendet.'],
  info_mail: ['Möchte zuerst Unterlagen sehen. Use-Case-Mail zu Belegerfassung versprochen.', 'Bitte Infos per Mail, dann Termin.'],
  later: ['Aktuell ERP-Umstellung, im neuen Jahr wieder melden.', 'Budget fürs nächste Jahr wird im Februar gemacht, dann nochmals anrufen.'],
  no_need: ['Kein Bedarf im Moment, Prioritäten liegen woanders.', 'Aktuell keine Kapazität für neue Projekte.'],
  has_partner: ['Arbeiten mit einem IT-Partner, der auch KI anbietet.', 'Hat bereits Partner für Digitalisierung, kein Bedarf.'],
  internal_group: ['Gehört zu einer Gruppe, IT wird zentral in Deutschland entschieden.'],
  too_small: ['Nur 3 Mitarbeitende, Inhaber macht alles selbst.'],
  do_not_contact: ['Möchte nicht mehr kontaktiert werden, bitte aus allen Listen entfernen.'],
  competitor: ['Ist selbst IT-Dienstleister mit KI-Angebot.'],
  wrong_person: ['Person arbeitet nicht mehr hier, Nachfolge unbekannt.'],
  wrong_number: ['Nummer gehört zu einer Privatperson.'],
  legacy: ['Gespräch mit GL, Interesse an Digitalisierung, Unterlagen gesendet.', 'Kurzer Austausch zu ERP-Ablösung.', 'Termin für Präsentation besprochen.'],
};

export const MEETING_SUBJECTS = [
  'Kundentermin',
  'Projektmeeting',
  'Interne Besprechung',
  'Workshop Kunde',
  'Teammeeting',
  'Statusmeeting Projekt',
  'Mittagessen Kunde',
  'Schulung',
  'Offertbesprechung',
  'Telefonkonferenz',
];

export const CAMPAIGNS = [
  { name: 'KI-Kampagne Herbst 2026', ageDays: [10, 80] as [number, number] },
  { name: 'KI-Kampagne Frühling 2026', ageDays: [100, 200] as [number, number] },
];

export const CAMPAIGN_SUBJECTS = [
  'KI im Alltag von {Firma}?',
  'Wie {Branche}-Firmen Offerten in Minuten erstellen',
  'Kurze Frage zu Ihrer Belegerfassung',
  'Weniger Abtippen, mehr Zeit: ein Beispiel aus Ihrer Branche',
  'Letzte Nachricht von mir zu KI bei {Firma}',
];
