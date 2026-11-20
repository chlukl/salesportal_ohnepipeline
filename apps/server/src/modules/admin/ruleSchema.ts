/**
 * zod validation of result-group rules (INTENT 6.5 «Wie es gebaut wird») against the shared `ResultGroupRule` type,
 * plus the field catalogue the admin editor offers. Codes are checked against the option sets in i18n.ts.
 */
import {
  OPTION_SETS,
  RESULT_GROUP_KEYS,
  type FieldAction,
  type LeadFieldName,
  type OptionSetName,
  type ResultGroupRule,
  type ResultInput,
  type RuleCondition,
} from '@sales-portal/shared';
import { z } from 'zod';

// ---------------------------------------------------------------------------------------------------------------------
// Catalogues
// ---------------------------------------------------------------------------------------------------------------------

export type LeadFieldType = 'text' | 'number' | 'boolean' | 'option' | 'multioption';

export interface LeadFieldMeta {
  field: LeadFieldName;
  label: string;
  type: LeadFieldType;
  optionSet?: OptionSetName;
}

/** Lead fields a rule may change (state/status only via «disqualifizieren»; ids and owner are handled by the engine). */
export const RULE_LEAD_FIELDS: LeadFieldMeta[] = [
  { field: 'kls_callstatus', label: 'Anrufstatus', type: 'option', optionSet: 'kls_callstatus' },
  { field: 'kls_rating_category', label: 'Bewertung Sales', type: 'option', optionSet: 'kls_rating_category' },
  { field: 'kls_lead_support', label: 'Lead-Support', type: 'option', optionSet: 'kls_lead_support' },
  { field: 'kls_interests', label: 'Interessen', type: 'multioption', optionSet: 'kls_interests' },
  { field: 'leadsourcecode', label: 'Leadursprung', type: 'option', optionSet: 'leadsourcecode' },
  { field: 'kls_salutation', label: 'Anrede', type: 'option', optionSet: 'kls_salutation' },
  { field: 'subject', label: 'Thema', type: 'text' },
  { field: 'decisionmaker', label: 'Entscheider', type: 'boolean' },
  { field: 'donotphone', label: 'Nicht anrufen', type: 'boolean' },
  { field: 'donotemail', label: 'Keine E-Mails', type: 'boolean' },
  { field: 'donotbulkemail', label: 'Keine Massenmails', type: 'boolean' },
  { field: 'kls_competitor', label: 'Mitbewerber', type: 'boolean' },
  { field: 'numberofemployees', label: 'Mitarbeitende', type: 'number' },
  { field: 'jobtitle', label: 'Funktion', type: 'text' },
  { field: 'emailaddress1', label: 'E-Mail', type: 'text' },
  { field: 'telephone1', label: 'Telefon', type: 'text' },
  { field: 'mobilephone', label: 'Mobiltelefon', type: 'text' },
  { field: 'kls_industry', label: 'Branche', type: 'text' },
  { field: 'kls_custom_industry', label: 'Eigene Kategorie', type: 'text' },
];

const FIELD_NAMES = RULE_LEAD_FIELDS.map((f) => f.field) as [LeadFieldName, ...LeadFieldName[]];
const FIELD_BY_NAME = new Map(RULE_LEAD_FIELDS.map((f) => [f.field, f]));

/** Every key of `ResultInput` (the compile-time check below fails when the shared type gets a new input). */
export const RESULT_INPUT_KEYS = [
  'followUpAt',
  'interest',
  'employees',
  'correctedPhone',
  'correctedPhoneField',
  'decisionMakerInMeeting',
  'reason',
  'newPerson',
  'budgetMentioned',
] as const satisfies readonly (keyof ResultInput)[];
type MissingInputKeys = Exclude<keyof ResultInput, (typeof RESULT_INPUT_KEYS)[number]>;
const _allInputsListed: MissingInputKeys extends never ? true : never = true;
void _allInputsListed;

export const RESULT_INPUT_LABELS: Record<(typeof RESULT_INPUT_KEYS)[number], string> = {
  followUpAt: 'Datum Rückruf / Wiedervorlage',
  interest: 'Interesse (0–3)',
  employees: 'Genannte Anzahl Mitarbeitende',
  correctedPhone: 'Korrigierte Nummer',
  correctedPhoneField: 'Feld der korrigierten Nummer',
  decisionMakerInMeeting: 'Entscheider im Termin',
  reason: 'Grund / Beleg aus dem Gespräch',
  newPerson: 'Neue Ansprechperson',
  budgetMentioned: 'Budget genannt',
};

// ---------------------------------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------------------------------

/** Rejects HTML tags (templates and rule texts are plain text; the portal renders them as text anyway). */
export const HTML_TAG_RE = /<\/?[a-zA-Z!?][^>]*>/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function plainText(max: number) {
  return z
    .string()
    .max(max, `höchstens ${max} Zeichen`)
    .refine((v) => !HTML_TAG_RE.test(v), 'Bitte nur Text – keine HTML-Tags')
    .refine((v) => !CONTROL_RE.test(v), 'Ungültige Steuerzeichen');
}

function codeIn(set: OptionSetName) {
  const codes = new Set(OPTION_SETS[set].map((o) => o.code));
  return z
    .number()
    .int()
    .refine((c) => codes.has(c), `unbekannter Code für ${set}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------------------------------

const inputKey = z.enum(RESULT_INPUT_KEYS);

export const conditionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('always') }),
  z.strictObject({ kind: z.literal('interest_gte'), value: z.number().int().min(0).max(3) }),
  z.strictObject({ kind: z.literal('employees_lt'), value: z.number().int().min(0).max(1_000_000) }),
  z.strictObject({ kind: z.literal('employees_gte'), value: z.number().int().min(0).max(1_000_000) }),
  z.strictObject({ kind: z.literal('input_true'), input: inputKey }),
  z.strictObject({ kind: z.literal('input_present'), input: inputKey }),
  z.strictObject({ kind: z.literal('input_absent'), input: inputKey }),
]);

const offsetDays = z.number().int().min(0).max(3650);

export const fieldActionSchema = z
  .strictObject({
    kind: z.enum(['set', 'add_to_multiselect', 'set_if_empty', 'disqualify', 'note', 'task', 'research']),
    field: z.enum(FIELD_NAMES).optional(),
    label: plainText(120).optional(),
    value: z.union([plainText(500), z.number().finite(), z.boolean(), z.null()]).optional(),
    valueFrom: inputKey.optional(),
    condition: conditionSchema.optional(),
    statuscode: codeIn('statuscode').optional(),
    text: plainText(2000).optional(),
    taskSubject: plainText(200).optional(),
    offsetDays: offsetDays.optional(),
    offsetWorkdays: offsetDays.optional(),
    dueFrom: inputKey.optional(),
  })
  .superRefine((a, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (a.kind === 'set' || a.kind === 'add_to_multiselect' || a.kind === 'set_if_empty') {
      if (!a.field) return issue('field', 'Feld wählen');
      if (a.value === undefined && !a.valueFrom) issue('value', 'Wert oder Eingabe wählen');
      const meta = FIELD_BY_NAME.get(a.field)!;
      if (a.kind === 'add_to_multiselect' && meta.type !== 'multioption') issue('kind', '«Hinzufügen» geht nur bei Mehrfachauswahl-Feldern');
      if (a.kind !== 'add_to_multiselect' && meta.type === 'multioption') issue('kind', 'Mehrfachauswahl-Felder nur mit «zu Mehrfachauswahl hinzufügen»');
      if (a.value !== undefined && a.value !== null) {
        if ((meta.type === 'option' || meta.type === 'multioption') && meta.optionSet) {
          const ok = typeof a.value === 'number' && OPTION_SETS[meta.optionSet].some((o) => o.code === a.value);
          if (!ok) issue('value', 'Wert ist kein gültiger Code dieses Felds');
        }
        if (meta.type === 'boolean' && typeof a.value !== 'boolean') issue('value', 'Ja oder Nein');
        if (meta.type === 'number' && typeof a.value !== 'number') issue('value', 'Zahl erwartet');
        if (meta.type === 'text' && typeof a.value !== 'string') issue('value', 'Text erwartet');
      }
    }
    if (a.kind === 'disqualify' && a.statuscode == null) issue('statuscode', 'Statusgrund wählen');
    if (a.kind === 'note' && !a.text?.trim()) issue('text', 'Notiztext fehlt');
    if (a.kind === 'task' && !a.taskSubject?.trim()) issue('taskSubject', 'Betreff der Aufgabe fehlt');
  });

const byDateStep = z.strictObject({ maxDays: z.number().int().min(0).max(3650).nullable(), value: codeIn('kls_callstatus') });

export const callStatusSchema = z
  .strictObject({
    mode: z.enum(['fixed', 'by_date', 'none']),
    value: codeIn('kls_callstatus').optional(),
    byDate: z.array(byDateStep).max(10).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.mode === 'fixed' && c.value == null) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Anrufstatus wählen' });
    if (c.mode === 'by_date') {
      const steps = c.byDate ?? [];
      if (steps.length === 0) return ctx.addIssue({ code: 'custom', path: ['byDate'], message: 'Mindestens eine Stufe nach Datum' });
      if (steps[steps.length - 1].maxDays !== null) ctx.addIssue({ code: 'custom', path: ['byDate'], message: 'Letzte Stufe muss «später» sein (ohne Tagesgrenze)' });
      for (let i = 1; i < steps.length; i++) {
        const prev = steps[i - 1].maxDays;
        const cur = steps[i].maxDays;
        if (prev === null || (cur !== null && cur <= prev)) {
          ctx.addIssue({ code: 'custom', path: ['byDate', i], message: 'Tagesgrenzen aufsteigend ordnen' });
        }
      }
    }
  });

export const followUpSchema = z.strictObject({
  type: z.enum(['task', 'mail', 'booking', 'research', 'none']),
  offsetDays: offsetDays.optional(),
  offsetWorkdays: offsetDays.optional(),
  dueFrom: inputKey.optional(),
  taskSubject: plainText(200).optional(),
  hint: plainText(300).optional(),
});

export const resultGroupRuleSchema = z.strictObject({
  key: z.enum(RESULT_GROUP_KEYS),
  label: plainText(80).refine((v) => v.trim().length > 0, 'Name fehlt'),
  description: plainText(500).optional(),
  version: z.number().int().min(1),
  anrufergebnis: codeIn('kls_anrufergebnis'),
  callStatus: callStatusSchema,
  ratingCategory: z.strictObject({ value: codeIn('kls_rating_category'), condition: conditionSchema.optional() }).nullable().optional(),
  state: z.enum(['keep', 'contacted']).optional(),
  fieldActions: z.array(fieldActionSchema).max(30),
  followUp: followUpSchema,
  setsOwnerToCaller: z.boolean(),
  setsContacted: z.boolean(),
  isRealContact: z.boolean(),
  inputs: z.array(inputKey).max(RESULT_INPUT_KEYS.length).optional(),
  shortcut: z
    .string()
    .regex(/^[a-z0-9]$/, 'ein Buchstabe oder eine Ziffer')
    .optional(),
  sortOrder: z.number().int().min(0).max(10_000),
  active: z.boolean(),
});

// Compile-time contract: the validated value is a ResultGroupRule (and its parts match the shared types).
type Parsed = z.infer<typeof resultGroupRuleSchema>;
const _ruleIsShared = (r: Parsed): ResultGroupRule => r;
const _actionIsShared = (a: z.infer<typeof fieldActionSchema>): FieldAction => a;
const _conditionIsShared = (c: z.infer<typeof conditionSchema>): RuleCondition => c;
void _ruleIsShared;
void _actionIsShared;
void _conditionIsShared;

export function parseRule(input: unknown): ResultGroupRule {
  return resultGroupRuleSchema.parse(input);
}
