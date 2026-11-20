/**
 * Use-Case-Katalog (INTENT 3: AI-Spezialist sieht/pflegt «Use Cases»; Quelle für Spickzettel 6.2, Use-Case-Mail 6.7,
 * Briefing 6.10 und die Kampagnen-Kennungen 6.17 / offene Frage 6).
 *
 * Storage: one row in the generic `settings` table (key `useCases.catalog`, zod-validated – no schema change). Until
 * somebody edits the catalog, the built-in defaults (`USE_CASES` in shared/i18n.ts + texts below) are returned.
 * Ids are stable campaign keys: they can be created but never renamed or deleted (old campaign mails keep resolving);
 * entries are hidden with `active: false` instead.
 *
 * Other modules read the catalog through `getUseCaseCatalog(db)` / `useCaseLabelFrom(catalog, id)`.
 */
import { USE_CASES, type Actor, type UseCaseEntry } from '@sales-portal/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '../../db/client';
import { settings } from '../../db/schema';
import { audit } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';
import { plainText } from './ruleSchema';

export const USE_CASE_SETTING_KEY = 'useCases.catalog';
export const MAX_USE_CASES = 200;

/** Campaign key: upper-case letters, digits, «-» or «_», 2–40 characters (e.g. `UC-DOC`). */
export const USE_CASE_ID_RE = /^[A-Z0-9][A-Z0-9_-]{0,38}[A-Z0-9]$/;

const nonEmpty = (max: number, msg: string) => plainText(max).transform((v) => v.trim()).refine((v) => v.length > 0, msg);

const industriesSchema = z
  .array(plainText(60).transform((v) => v.trim().replace(/\s+/g, ' ')))
  .max(30, 'höchstens 30 Branchen-Stichworte')
  .transform((list) => {
    const seen = new Set<string>();
    return list.filter((v) => {
      const k = v.toLowerCase();
      if (!v || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });

export const useCaseIdSchema = z
  .string()
  .transform((v) => v.trim().toUpperCase())
  .refine((v) => USE_CASE_ID_RE.test(v), 'Kennung: 2–40 Zeichen, nur Grossbuchstaben, Ziffern, «-» oder «_» (z. B. UC-DOC)');

const fields = {
  label: nonEmpty(120, 'Titel fehlt'),
  short: nonEmpty(40, 'Kurzname fehlt'),
  description: plainText(600).transform((v) => v.trim()),
  industries: industriesSchema,
  active: z.boolean(),
};

export const useCaseCreateSchema = z.strictObject({
  id: useCaseIdSchema,
  label: fields.label,
  short: fields.short,
  description: fields.description.default(''),
  industries: fields.industries.default([]),
  active: fields.active.default(true),
});

export const useCaseUpdateSchema = z
  .strictObject({
    label: fields.label.optional(),
    short: fields.short.optional(),
    description: fields.description.optional(),
    industries: fields.industries.optional(),
    active: fields.active.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Keine Änderung');

export type UseCaseCreateInput = z.input<typeof useCaseCreateSchema>;
export type UseCaseUpdateInput = z.input<typeof useCaseUpdateSchema>;

/** Stored shape (without the derived `builtIn`). */
const storedEntrySchema = z.object({
  id: z.string().regex(USE_CASE_ID_RE),
  label: z.string().min(1).max(120),
  short: z.string().min(1).max(40),
  description: z.string().max(600),
  industries: z.array(z.string().max(60)).max(30),
  active: z.boolean(),
  updatedAt: z.string().nullable(),
  updatedByName: z.string().nullable(),
});
const storedCatalogSchema = z.array(storedEntrySchema).max(MAX_USE_CASES);
type StoredEntry = z.infer<typeof storedEntrySchema>;

/** Texts and typical industries for the built-in catalog (same industries the cheat sheet suggests). */
const DEFAULT_DETAILS: Record<string, { description: string; industries: string[] }> = {
  'UC-DOC': {
    description: 'Lieferantenrechnungen, Spesen und Belege werden gelesen, vorkontiert und ins Buchhaltungssystem übergeben.',
    industries: ['Treuhand', 'Logistik', 'Immobilien'],
  },
  'UC-OFFER': {
    description: 'Aus Anfrage, Plänen und Preislisten entsteht ein Offert-Entwurf, den das Team nur noch prüft.',
    industries: ['Bau', 'Holzbau', 'Metallbau', 'Maschinenbau', 'Druck und Medien'],
  },
  'UC-MAIL': {
    description: 'Eingehende Mails werden sortiert, zugewiesen und mit einem Antwort-Entwurf versehen.',
    industries: ['Grosshandel', 'Detailhandel', 'Treuhand', 'Immobilien', 'Öffentliche Hand'],
  },
  'UC-KNOW': {
    description: 'Ein interner Chat beantwortet Fragen aus Handbüchern, Normen und Vorschriften – mit Quellenangabe.',
    industries: ['Medizintechnik', 'Chemie', 'Öffentliche Hand', 'Gesundheitswesen'],
  },
  'UC-QA': {
    description: 'Prüfprotokolle und Messberichte werden ausgewertet, Abweichungen fallen sofort auf.',
    industries: ['Maschinenbau', 'Elektro/Elektronik-Fertigung', 'Medizintechnik', 'Kunststoff', 'Chemie', 'Lebensmittel'],
  },
  'UC-ORDER': {
    description: 'Bestellungen und Lieferscheine aus PDFs werden erkannt und direkt ins ERP übernommen.',
    industries: ['Metallbau', 'Elektro/Elektronik-Fertigung', 'Kunststoff', 'Grosshandel', 'Logistik', 'Lebensmittel', 'Druck und Medien'],
  },
  'UC-REPORT': {
    description: 'Berichte und Kennzahlen werden automatisch zusammengefasst und verständlich kommentiert.',
    industries: ['Energie'],
  },
  'UC-SERVICE': {
    description: 'Serviceanfragen und Reklamationen werden vorqualifiziert und mit den nötigen Angaben weitergeleitet.',
    industries: ['Detailhandel', 'Energie'],
  },
  'UC-TENDER': {
    description: 'Ausschreibungen, Devis und Pläne werden vorgeprüft – wichtige Punkte und Fristen stehen auf einen Blick.',
    industries: ['Bau', 'Holzbau'],
  },
  'UC-HR': {
    description: 'Bewerbungen werden vorsortiert und Routinearbeiten der Personaladministration erledigt.',
    industries: ['Gesundheitswesen'],
  },
};

const BUILT_IN_IDS = new Set(USE_CASES.map((u) => u.id));

export function defaultUseCaseCatalog(): UseCaseEntry[] {
  return USE_CASES.map((u) => ({
    id: u.id,
    label: u.label,
    short: u.short,
    description: DEFAULT_DETAILS[u.id]?.description ?? '',
    industries: [...(DEFAULT_DETAILS[u.id]?.industries ?? [])],
    active: true,
    builtIn: true,
    updatedAt: null,
    updatedByName: null,
  }));
}

function withBuiltIn(list: StoredEntry[]): UseCaseEntry[] {
  return list.map((e) => ({ ...e, builtIn: BUILT_IN_IDS.has(e.id) }));
}

function toStored(list: UseCaseEntry[]): StoredEntry[] {
  return list.map(({ builtIn: _builtIn, ...rest }) => rest);
}

/** Active entries first (catalog order), hidden ones after. */
export function sortUseCases(list: UseCaseEntry[]): UseCaseEntry[] {
  return [...list.filter((u) => u.active), ...list.filter((u) => !u.active)];
}

/** Full catalog (stored version, or the built-in defaults while nobody has edited it). Invalid stored data → defaults. */
export async function getUseCaseCatalog(db: Db | Tx): Promise<UseCaseEntry[]> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, USE_CASE_SETTING_KEY));
  return parseCatalog(row?.value);
}

function parseCatalog(value: unknown): UseCaseEntry[] {
  if (value === undefined) return defaultUseCaseCatalog();
  const parsed = storedCatalogSchema.safeParse(value);
  return parsed.success ? withBuiltIn(parsed.data) : defaultUseCaseCatalog();
}

/** Reads the catalog with a row lock (read-modify-write without lost updates between two editors). */
async function lockedCatalog(tx: Tx, actor: Actor): Promise<UseCaseEntry[]> {
  await tx
    .insert(settings)
    .values({ key: USE_CASE_SETTING_KEY, value: toStored(defaultUseCaseCatalog()), updatedBy: actor.userId, updatedAt: new Date() })
    .onConflictDoNothing();
  const [row] = await tx.select({ value: settings.value }).from(settings).where(eq(settings.key, USE_CASE_SETTING_KEY)).for('update');
  return parseCatalog(row?.value);
}

/** Label for a campaign key; unknown keys stay recognisable as such (never an empty string). */
export function useCaseLabelFrom(catalog: readonly Pick<UseCaseEntry, 'id' | 'label'>[], id: string): string {
  const key = id.trim().toUpperCase();
  return catalog.find((u) => u.id === key)?.label ?? `Unbekannter Use Case (${id})`;
}

async function store(db: Tx, actor: Actor, list: UseCaseEntry[]): Promise<void> {
  const value = storedCatalogSchema.parse(toStored(list));
  await db
    .insert(settings)
    .values({ key: USE_CASE_SETTING_KEY, value, updatedBy: actor.userId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedBy: actor.userId, updatedAt: new Date() } });
}

const snapshot = (u: UseCaseEntry) => ({ label: u.label, short: u.short, description: u.description, industries: u.industries, active: u.active });

/** Adds a use case with a new, unique campaign key (audited). */
export async function createUseCase(db: Db, actor: Actor, input: UseCaseCreateInput, now = new Date()): Promise<UseCaseEntry> {
  const data = useCaseCreateSchema.parse(input);
  return db.transaction(async (tx) => {
    const list = await lockedCatalog(tx, actor);
    if (list.some((u) => u.id === data.id)) throw conflict(`Die Kennung ${data.id} gibt es schon`, 'use_case_exists');
    if (list.length >= MAX_USE_CASES) throw conflict(`Höchstens ${MAX_USE_CASES} Use Cases`, 'use_case_limit');
    const entry: UseCaseEntry = { ...data, builtIn: BUILT_IN_IDS.has(data.id), updatedAt: now.toISOString(), updatedByName: actor.displayName };
    await store(tx, actor, [...list, entry]);
    await audit(tx, { actor, action: 'admin.use_case_create', entity: 'use_case', entityId: entry.id, newValue: snapshot(entry) });
    return entry;
  });
}

/** Changes texts/industries/visibility of an existing use case; the key itself never changes (audited). */
export async function updateUseCase(db: Db, actor: Actor, id: string, patch: UseCaseUpdateInput, now = new Date()): Promise<UseCaseEntry> {
  const data = useCaseUpdateSchema.parse(patch);
  const key = id.trim().toUpperCase();
  return db.transaction(async (tx) => {
    const list = await lockedCatalog(tx, actor);
    const index = list.findIndex((u) => u.id === key);
    if (index < 0) throw notFound('Use Case nicht gefunden');
    const old = list[index];
    const next: UseCaseEntry = {
      ...old,
      ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
      updatedAt: now.toISOString(),
      updatedByName: actor.displayName,
    };
    const updated = [...list];
    updated[index] = next;
    await store(tx, actor, updated);
    await audit(tx, { actor, action: 'admin.use_case_update', entity: 'use_case', entityId: key, oldValue: snapshot(old), newValue: snapshot(next) });
    return next;
  });
}
