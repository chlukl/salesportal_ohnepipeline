/**
 * Output schemas of the AI adapter (INTENT 6.4, 6.7, 6.10).
 *
 * - `*_JSON_SCHEMA`: JSON schema handed to Claude as structured output format (strict: every property required,
 *   `additionalProperties: false`, nullable via type unions).
 * - `*Schema` (zod): validation of every AI output – mock and live – before it is stored. Model output is untrusted.
 * - `sanitize*`: post-validation clean-up (unknown use-case ids dropped, field whitelist, length caps).
 */
import { RESULT_GROUP_KEYS, USE_CASES, type Briefing, type CallAnalysis, type LeadFieldName, type UseCaseMailDraft } from '@sales-portal/shared';
import { z } from 'zod';

/** Lead fields the AI may propose (never owner, state, status or campaign fields). */
export const AI_PROPOSABLE_FIELDS = [
  'kls_callstatus',
  'kls_rating_category',
  'numberofemployees',
  'decisionmaker',
  'jobtitle',
  'emailaddress1',
  'telephone1',
  'mobilephone',
] as const satisfies readonly LeadFieldName[];
export type AiProposableField = (typeof AI_PROPOSABLE_FIELDS)[number];

export const OBJECTIONS = ['partner', 'internal_group', 'too_small', 'no_budget', 'bad_timing', 'no_interest'] as const;

const USE_CASE_IDS = new Set(USE_CASES.map((u) => u.id));
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

const text = (max: number) => z.string().trim().max(max);

export const CallAnalysisSchema = z.object({
  summary: text(2000).min(1),
  interest: z.object({
    level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    reason: text(600),
    quote: text(400).nullable(),
  }),
  needs: z.array(z.object({ text: text(400), useCaseIds: z.array(z.string().max(40)).max(5) })).max(8),
  decisionMaker: z.object({
    reached: z.enum(['yes', 'no', 'forwarded']),
    forwardedTo: z
      .object({ name: text(120).nullable(), jobtitle: text(120).nullable(), email: text(200).nullable() })
      .nullable()
      .optional(),
  }),
  objections: z.array(z.enum(OBJECTIONS)).max(6),
  suggestion: z.object({
    resultGroup: z.enum(RESULT_GROUP_KEYS).nullable(),
    nextStep: text(400).nullable(),
    nextStepDate: z.string().regex(isoDate).nullable().catch(null),
    fields: z
      .array(
        z.object({
          field: z.enum(AI_PROPOSABLE_FIELDS),
          value: z.union([z.string().max(300), z.number(), z.boolean(), z.null()]),
          reason: text(300),
        }),
      )
      .max(8),
    preparationNeeded: z.boolean(),
  }),
});

export const UseCaseMailDraftSchema = z.object({
  subject: text(200).min(1),
  body: text(6000).min(1),
  useCaseIds: z.array(z.string().max(40)).max(10),
  sources: z.array(z.object({ claim: text(300), source: text(300) })).max(10),
});

export const BriefingSchema = z.object({
  company: text(200),
  profile: text(1500),
  contact: text(600),
  campaignContext: text(2000).nullable(),
  history: text(2500),
  useCases: z.array(z.object({ id: z.string().max(40), why: text(500) })).max(5),
  openingQuestions: z.array(text(300)).max(6),
  openPoints: z.array(text(300)).max(8),
  preparation: z.array(text(300)).max(8),
});

const keepKnownUseCases = (ids: string[]) => [...new Set(ids.filter((id) => USE_CASE_IDS.has(id)))];

/** Validate + clean an analysis (throws ZodError on invalid shape). */
export function sanitizeCallAnalysis(raw: unknown): CallAnalysis {
  const a = CallAnalysisSchema.parse(raw);
  return {
    ...a,
    needs: a.needs.map((n) => ({ text: n.text, useCaseIds: keepKnownUseCases(n.useCaseIds) })),
    decisionMaker: {
      reached: a.decisionMaker.reached,
      forwardedTo: a.decisionMaker.reached === 'forwarded' ? (a.decisionMaker.forwardedTo ?? null) : null,
    },
    objections: [...new Set(a.objections)],
    suggestion: {
      ...a.suggestion,
      // One proposal per field.
      fields: a.suggestion.fields.filter((f, i, all) => all.findIndex((x) => x.field === f.field) === i),
    },
  };
}

export function sanitizeUseCaseMail(raw: unknown): UseCaseMailDraft {
  const m = UseCaseMailDraftSchema.parse(raw);
  return { ...m, useCaseIds: keepKnownUseCases(m.useCaseIds).slice(0, 2) };
}

export function sanitizeBriefing(raw: unknown): Briefing {
  const b = BriefingSchema.parse(raw);
  return { ...b, useCases: b.useCases.filter((u) => USE_CASE_IDS.has(u.id)) };
}

// ---------------------------------------------------------------------------------------------------------------------
// JSON schemas for Claude structured output (strict: all properties required, no additional properties)
// ---------------------------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const str = (description?: string): Json => ({ type: 'string', ...(description ? { description } : {}) });
const nstr = (description?: string): Json => ({ type: ['string', 'null'], ...(description ? { description } : {}) });
const obj = (properties: Record<string, Json>): Json => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const arr = (items: Json, description?: string): Json => ({ type: 'array', items, ...(description ? { description } : {}) });
const useCaseIdEnum: Json = { type: 'string', enum: USE_CASES.map((u) => u.id) };

export const CALL_ANALYSIS_JSON_SCHEMA: Json = obj({
  summary: str('3–5 Sätze Deutsch (Schweiz, ss statt ß), Fakten mit Zeitangaben aus dem Gespräch'),
  interest: obj({
    level: { type: 'integer', enum: [0, 1, 2, 3], description: '0 kein · 1 schwach · 2 offen · 3 klar' },
    reason: str('Begründung'),
    quote: nstr('wörtliches Zitat aus dem Transkript oder der Notiz, sonst null'),
  }),
  needs: arr(obj({ text: str('genannter Ablauf, System oder Problem'), useCaseIds: arr(useCaseIdEnum) })),
  decisionMaker: obj({
    reached: { type: 'string', enum: ['yes', 'no', 'forwarded'] },
    forwardedTo: {
      anyOf: [obj({ name: nstr(), jobtitle: nstr(), email: nstr('nur wenn im Gespräch genannt') }), { type: 'null' }],
    },
  }),
  objections: arr({ type: 'string', enum: [...OBJECTIONS] }),
  suggestion: obj({
    resultGroup: { type: ['string', 'null'], enum: [...RESULT_GROUP_KEYS, null] },
    nextStep: nstr(),
    nextStepDate: nstr('YYYY-MM-DD oder null'),
    fields: arr(
      obj({
        field: { type: 'string', enum: [...AI_PROPOSABLE_FIELDS] },
        value: { type: ['string', 'number', 'boolean', 'null'] },
        reason: str(),
      }),
    ),
    preparationNeeded: { type: 'boolean', description: 'Muss für ein Erstgespräch etwas vorbereitet werden (Demo, Prototyp, Unterlagen)?' },
  }),
});

export const USE_CASE_MAIL_JSON_SCHEMA: Json = obj({
  subject: str(),
  body: str('Klartext, Deutsch (Schweiz, ss statt ß), Sie-Form, ohne Platzhalter'),
  useCaseIds: arr(useCaseIdEnum, '1–2 Use Cases'),
  sources: arr(obj({ claim: str('Aufhänger / Aussage im Mail'), source: str('Quelle aus den Daten (z. B. «Notiz», «KI-Bewertung», «Website»)') })),
});

export const BRIEFING_JSON_SCHEMA: Json = obj({
  company: str(),
  profile: str('Kurzprofil: Grösse, Branche, was die Firma macht'),
  contact: str('Ansprechperson und Rolle'),
  campaignContext: nstr('nur bei Kampagnen-Kontakten: erhaltene Mails, gepushte Use Cases, Reaktion'),
  history: str('Coldcall-Zusammenfassung und frühere Kontakte'),
  useCases: arr(obj({ id: useCaseIdEnum, why: str('aus Sicht des gebuchten Sales') })),
  openingQuestions: arr(str()),
  openPoints: arr(str()),
  preparation: arr(str()),
});
