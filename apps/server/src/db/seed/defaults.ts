/**
 * Reference data seeded in every mode when missing (never overwrites admin changes):
 * result-group rules v1, templates, objection answers, settings.
 */
import { DEFAULT_RESULT_GROUP_RULES, type BookingRules, type SettingsMap } from '@sales-portal/shared';
import type { Db } from '../client';
import { objections, resultGroupRules, settings, templates } from '../schema';
import { DEMO_EMAILS } from './users';

export const DEFAULT_BOOKING_RULES: BookingRules = {
  startWindows: [
    { from: '09:00', to: '11:30' },
    { from: '14:00', to: '16:00' },
  ],
  blockedWindows: [{ from: '12:30', to: '14:00' }],
  durationMinutes: 30,
  bufferBeforeMinutes: 30,
  bufferAfterMinutes: 30,
  slotStepMinutes: 30,
  defaultSalesEmail: DEMO_EMAILS.manuel,
  specialistEmail: DEMO_EMAILS.nico,
  extraCallSalesEmail: DEMO_EMAILS.lukas,
  subjectTemplate: 'Vorstellung der Kallysoft Informatik AG als KI-Spezialist – {Firma}',
  outlookCategory: 'Kallysoft Erstgespräch',
  briefingCategory: 'Kallysoft Briefing',
  briefingMailDaysBefore: 7,
  timezone: 'Europe/Zurich',
};

export const DEFAULT_SETTINGS: SettingsMap = {
  'transcripts.retentionDays': 30,
  'analysis.timeoutMinutes': 30,
  'booking.rules': DEFAULT_BOOKING_RULES,
  'calls.notReachedMailThreshold': { attempts: 3, withinDays: 14 },
  'campaign.lockMonths': 3,
  'tasks.maxPerPersonPerDay': 3,
  'ai.monthlyBudgetUsd': 100,
};

export const DEFAULT_TEMPLATES: { key: string; label: string; kind: 'subject' | 'invitation' | 'mail' | 'briefing' | 'proposals'; subject: string | null; body: string }[] = [
  {
    key: 'booking.subject',
    label: 'Betreff Erstgespräch',
    kind: 'subject',
    subject: null,
    body: 'Vorstellung der Kallysoft Informatik AG als KI-Spezialist – {Firma}',
  },
  {
    key: 'booking.invitation',
    label: 'Einladung Erstgespräch (Teams)',
    kind: 'invitation',
    subject: 'Vorstellung der Kallysoft Informatik AG als KI-Spezialist – {Firma}',
    body: [
      'Guten Tag {Anrede} {Nachname}',
      '',
      'Vielen Dank für das freundliche Gespräch. Wie besprochen stellen wir Ihnen am {Datum} um {Uhrzeit} Uhr in 30 Minuten vor,',
      'wo KI in Ihrem Alltag konkret Zeit spart – mit Beispielen aus Ihrer Branche.',
      '',
      'Dabei sind {Sales} (Kallysoft) und {Spezialist} (KI-Spezialist). Den Teams-Link finden Sie in dieser Einladung.',
      '',
      'Freundliche Grüsse',
      '{Absender}',
      'Kallysoft Informatik AG',
    ].join('\n'),
  },
  {
    key: 'mail.proposals',
    label: 'Mail mit 3 Terminvorschlägen',
    kind: 'proposals',
    subject: 'Terminvorschläge: Kallysoft Informatik AG als KI-Spezialist – {Firma}',
    body: [
      'Guten Tag {Anrede} {Nachname}',
      '',
      'Vielen Dank für das Gespräch. Gerne zeigen wir Ihnen in 30 Minuten, wo KI bei {Firma} konkret Zeit spart.',
      'Passt Ihnen einer dieser Termine?',
      '',
      '{Vorschlaege}',
      '',
      'Eine kurze Antwort genügt, die Einladung schicke ich Ihnen danach direkt zu.',
      '',
      'Freundliche Grüsse',
      '{Absender}',
      'Kallysoft Informatik AG',
    ].join('\n'),
  },
  {
    key: 'mail.use_case',
    label: 'Use-Case-Mail (Rahmen für die KI)',
    kind: 'mail',
    subject: '{Firma}: {UseCase} mit KI',
    body: [
      'Guten Tag {Anrede} {Nachname}',
      '',
      '{Einleitung}',
      '',
      '{UseCases}',
      '',
      '{Terminangebot}',
      '',
      'Freundliche Grüsse',
      '{Absender}',
      'Kallysoft Informatik AG',
    ].join('\n'),
  },
  {
    key: 'mail.not_reached',
    label: 'Mail nach mehrmals «Nicht erreicht»',
    kind: 'mail',
    subject: 'Kurze Frage zu KI bei {Firma}',
    body: [
      'Guten Tag {Anrede} {Nachname}',
      '',
      'Ich habe Sie in den letzten Tagen telefonisch nicht erreicht. Darum kurz per Mail:',
      '{Einstieg}',
      '',
      'Hätten Sie 30 Minuten für ein kurzes Kennenlernen? {Terminangebot}',
      '',
      'Freundliche Grüsse',
      '{Absender}',
      'Kallysoft Informatik AG',
    ].join('\n'),
  },
  {
    key: 'briefing.default',
    label: 'Briefing Erstgespräch',
    kind: 'briefing',
    subject: 'Briefing: {Firma} – {Datum} {Uhrzeit}',
    body: [
      '{Kampagne}',
      'Firma: {Profil}',
      'Ansprechperson: {Kontakt}',
      'Verlauf: {Verlauf}',
      'Use Cases: {UseCases}',
      'Einstiegsfragen: {Fragen}',
      'Offene Punkte: {OffenePunkte}',
      'Vorbereiten: {Vorbereitung}',
    ].join('\n'),
  },
];

export const DEFAULT_OBJECTIONS = [
  {
    key: 'has_partner',
    label: 'Wir haben schon einen Partner',
    answer:
      'Das ist gut so – wir ersetzen niemanden. Viele Kunden holen uns gezielt für KI dazu, weil das ein eigenes Fachgebiet ist. 30 Minuten zeigen, ob es eine sinnvolle Ergänzung gibt.',
    sortOrder: 10,
  },
  {
    key: 'too_small',
    label: 'Dafür sind wir zu klein',
    answer:
      'Gerade kleinere Teams profitieren am schnellsten: Wenn eine Person pro Woche zwei Stunden bei Offerten oder Belegen spart, rechnet sich das. Wir starten bewusst klein.',
    sortOrder: 20,
  },
  {
    key: 'no_budget',
    label: 'Kein Budget',
    answer:
      'Verständlich. Das Erstgespräch ist unverbindlich und kostenlos – Sie sehen danach, was es bringt und was es kosten würde. Dann entscheiden Sie, ob es ins nächste Budget gehört.',
    sortOrder: 30,
  },
  {
    key: 'no_time',
    label: 'Keine Zeit',
    answer:
      'Darum geht es ja: Zeit zurückgewinnen. Wann passt es Ihnen besser – eher nächste Woche am Vormittag oder in zwei Wochen am Nachmittag? Es dauert 30 Minuten über Teams.',
    sortOrder: 40,
  },
];

/** Insert defaults where missing. Safe to run on every start. */
export async function seedDefaults(db: Db): Promise<void> {
  await db
    .insert(resultGroupRules)
    .values(
      DEFAULT_RESULT_GROUP_RULES.map((rule) => ({
        key: rule.key,
        version: rule.version,
        label: rule.label,
        definition: rule,
        isActive: true,
        sortOrder: rule.sortOrder,
      })),
    )
    .onConflictDoNothing();

  await db.insert(templates).values(DEFAULT_TEMPLATES).onConflictDoNothing();
  await db.insert(objections).values(DEFAULT_OBJECTIONS).onConflictDoNothing();
  await db
    .insert(settings)
    .values(Object.entries(DEFAULT_SETTINGS).map(([key, value]) => ({ key, value: value as unknown })))
    .onConflictDoNothing();
}
