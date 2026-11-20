/**
 * Admin service (INTENT 6.14, §3 roles). Every write is audited (`admin.*`). Callers must be real admins (routes check).
 */
import { randomUUID } from 'node:crypto';
import {
  ROLES,
  snapshotKey,
  zurichDate,
  type Actor,
  type AdminConnections,
  type AdminErrorItem,
  type AdminSettings,
  type AuditEntry,
  type BookingRules,
  type ObjectionAnswer,
  type Paged,
  type PortalUser,
  type ResultGroupKey,
  type ResultGroupRule,
  type ResultGroupRuleVersion,
  type Role,
  type SecretExpiry,
  type Template,
} from '@sales-portal/shared';
import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, lt, max, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { destroyUserSessions } from '../../auth/session';
import type { AppConfig } from '../../config';
import type { Db } from '../../db/client';
import { auditLog, changeSets, jobs, notifications, objections, resultGroupRules, syncState, templates, userRoles, users } from '../../db/schema';
import type { Adapters } from '../../integrations';
import { audit, auditMany } from '../../lib/audit';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { getAllSettings, getSetting, setSetting } from '../../lib/settings';
import { email, getExtraSetting, isoDate, setExtraSetting, type SecretName } from './extraSettings';
import { plainText, RESULT_INPUT_KEYS, RESULT_INPUT_LABELS, resultGroupRuleSchema, RULE_LEAD_FIELDS } from './ruleSchema';
import { validateTemplateText } from './templates';

// =====================================================================================================================
// Users and roles
// =====================================================================================================================

export async function listUsers(db: Db): Promise<PortalUser[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      crmUserId: users.crmUserId,
      isActive: users.isActive,
      role: userRoles.role,
    })
    .from(users)
    .leftJoin(userRoles, eq(userRoles.userId, users.id))
    .orderBy(asc(users.displayName));
  const map = new Map<string, PortalUser>();
  for (const r of rows) {
    const u = map.get(r.id) ?? { id: r.id, email: r.email, displayName: r.displayName, crmUserId: r.crmUserId, isActive: r.isActive, roles: [] as Role[] };
    if (r.role) u.roles.push(r.role as Role);
    map.set(r.id, u);
  }
  for (const u of map.values()) u.roles.sort((a, b) => ROLES.indexOf(a) - ROLES.indexOf(b));
  return [...map.values()];
}

async function getUser(db: Db, id: string): Promise<PortalUser> {
  const u = (await listUsers(db)).find((x) => x.id === id);
  if (!u) throw notFound('Benutzer nicht gefunden');
  return u;
}

async function activeAdminIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.role, 'admin'), eq(users.isActive, true)));
  return rows.map((r) => r.id);
}

/**
 * Rule (INTENT §3): nobody removes their own admin role (no self lock-out), and the last active admin keeps it.
 * Returns a German problem or null.
 */
export function roleChangeProblem(args: { actorId: string; targetId: string; currentRoles: Role[]; nextRoles: Role[]; activeAdminIds: string[] }): string | null {
  const losesAdmin = args.currentRoles.includes('admin') && !args.nextRoles.includes('admin');
  if (!losesAdmin) return null;
  if (args.actorId === args.targetId) return 'Die eigene Admin-Rolle kannst du nicht entfernen – sonst sperrst du dich aus.';
  if (args.activeAdminIds.filter((id) => id !== args.targetId).length === 0) return 'Es muss mindestens ein aktiver Admin bleiben.';
  return null;
}

export async function setUserRoles(db: Db, actor: Actor, userId: string, nextRoles: Role[]): Promise<PortalUser> {
  const user = await getUser(db, userId);
  const next = [...new Set(nextRoles)];
  const problem = roleChangeProblem({ actorId: actor.userId ?? '', targetId: userId, currentRoles: user.roles, nextRoles: next, activeAdminIds: await activeAdminIds(db) });
  if (problem) throw unprocessable(problem, 'role_change_forbidden');
  const grant = next.filter((r) => !user.roles.includes(r));
  const revoke = user.roles.filter((r) => !next.includes(r));
  if (grant.length === 0 && revoke.length === 0) return user;
  await db.transaction(async (tx) => {
    if (revoke.length) await tx.delete(userRoles).where(and(eq(userRoles.userId, userId), inArray(userRoles.role, revoke)));
    if (grant.length) await tx.insert(userRoles).values(grant.map((role) => ({ userId, role, grantedBy: actor.userId }))).onConflictDoNothing();
    await auditMany(tx, [
      ...grant.map((role) => ({ actor, action: 'admin.role_grant', entity: 'user', entityId: userId, field: 'role', newValue: role, meta: { email: user.email } })),
      ...revoke.map((role) => ({ actor, action: 'admin.role_revoke', entity: 'user', entityId: userId, field: 'role', oldValue: role, meta: { email: user.email } })),
    ]);
  });
  return getUser(db, userId);
}

export const createUserSchema = z.strictObject({
  email,
  displayName: plainText(120).refine((v) => v.trim().length >= 2, 'Name fehlt'),
  roles: z.array(z.enum(ROLES)).max(ROLES.length).default([]),
});

/** Pre-create a user for Entra login (linked by email at the first sign-in). */
export async function createUser(db: Db, actor: Actor, input: z.infer<typeof createUserSchema>): Promise<PortalUser> {
  const emailLc = input.email.toLowerCase();
  const [existing] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${emailLc}`);
  if (existing) throw conflict('Diese E-Mail-Adresse hat schon einen Zugang', 'user_exists');
  const roles = [...new Set(input.roles)];
  const id = await db.transaction(async (tx) => {
    const [row] = await tx.insert(users).values({ email: emailLc, displayName: input.displayName.trim() }).returning({ id: users.id });
    if (roles.length) await tx.insert(userRoles).values(roles.map((role) => ({ userId: row.id, role, grantedBy: actor.userId })));
    await auditMany(tx, [
      { actor, action: 'admin.user_create', entity: 'user', entityId: row.id, newValue: { email: emailLc, displayName: input.displayName.trim() } },
      ...roles.map((role) => ({ actor, action: 'admin.role_grant', entity: 'user', entityId: row.id, field: 'role', newValue: role, meta: { email: emailLc } })),
    ]);
    return row.id;
  });
  return getUser(db, id);
}

export async function setUserActive(db: Db, actor: Actor, userId: string, isActive: boolean): Promise<PortalUser> {
  const user = await getUser(db, userId);
  if (user.isActive === isActive) return user;
  if (!isActive) {
    if (userId === actor.userId) throw unprocessable('Du kannst deinen eigenen Zugang nicht sperren.', 'self_deactivate');
    if (user.roles.includes('admin') && (await activeAdminIds(db)).filter((id) => id !== userId).length === 0) {
      throw unprocessable('Es muss mindestens ein aktiver Admin bleiben.', 'last_admin');
    }
  }
  await db.update(users).set({ isActive, updatedAt: new Date() }).where(eq(users.id, userId));
  if (!isActive) await destroyUserSessions(db, userId);
  await audit(db, { actor, action: isActive ? 'admin.user_activate' : 'admin.user_deactivate', entity: 'user', entityId: userId, field: 'isActive', oldValue: !isActive, newValue: isActive });
  return getUser(db, userId);
}

// =====================================================================================================================
// Result-group rules (versioned)
// =====================================================================================================================

type RuleRow = typeof resultGroupRules.$inferSelect;

async function toVersions(db: Db, rows: RuleRow[]): Promise<ResultGroupRuleVersion[]> {
  const creatorIds = [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => !!x))];
  const names = new Map(
    (creatorIds.length ? await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, creatorIds)) : []).map((u) => [u.id, u.name]),
  );
  return rows.map((r) => ({
    id: r.id,
    key: r.key as ResultGroupKey,
    version: r.version,
    label: r.label,
    isActive: r.isActive,
    createdBy: r.createdBy,
    createdByName: r.createdBy ? (names.get(r.createdBy) ?? null) : null,
    createdAt: r.createdAt.toISOString(),
    definition: r.definition,
  }));
}

/** Active version per key, ordered like the wrap-up panel. */
export async function listActiveRules(db: Db): Promise<(ResultGroupRuleVersion & { versionCount: number })[]> {
  const rows = await db.select().from(resultGroupRules).where(eq(resultGroupRules.isActive, true)).orderBy(asc(resultGroupRules.sortOrder), asc(resultGroupRules.key));
  const counts = await db.select({ key: resultGroupRules.key, n: count() }).from(resultGroupRules).groupBy(resultGroupRules.key);
  const countByKey = new Map(counts.map((c) => [c.key, Number(c.n)]));
  return (await toVersions(db, rows)).map((v) => ({ ...v, versionCount: countByKey.get(v.key) ?? 1 }));
}

export async function listRuleVersions(db: Db, key: ResultGroupKey): Promise<ResultGroupRuleVersion[]> {
  const rows = await db.select().from(resultGroupRules).where(eq(resultGroupRules.key, key)).orderBy(desc(resultGroupRules.version));
  return toVersions(db, rows);
}

/**
 * Save = new version (old versions are kept so the dashboard knows which rule a call was saved with). The new version
 * becomes the only active one for its key.
 */
export async function saveRuleVersion(db: Db, actor: Actor, key: ResultGroupKey, input: unknown): Promise<ResultGroupRuleVersion> {
  const [{ maxVersion }] = await db.select({ maxVersion: max(resultGroupRules.version) }).from(resultGroupRules).where(eq(resultGroupRules.key, key));
  const [previous] = await db.select().from(resultGroupRules).where(and(eq(resultGroupRules.key, key), eq(resultGroupRules.isActive, true)));
  const version = (maxVersion ?? 0) + 1;
  const parsed = resultGroupRuleSchema.safeParse({ ...(input as Record<string, unknown>), key, version });
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 6).map((i) => `${i.path.join('.') || 'Regel'}: ${i.message}`);
    throw unprocessable(`Regel ist ungültig – ${issues.join(' · ')}`, 'rule_invalid');
  }
  const definition: ResultGroupRule = parsed.data;
  const id = await db.transaction(async (tx) => {
    await tx.update(resultGroupRules).set({ isActive: false }).where(eq(resultGroupRules.key, key));
    const [row] = await tx
      .insert(resultGroupRules)
      .values({ key, version, label: definition.label, definition, isActive: true, sortOrder: definition.sortOrder, createdBy: actor.userId })
      .returning({ id: resultGroupRules.id });
    await audit(tx, {
      actor,
      action: 'admin.rule_version',
      entity: 'result_group_rule',
      entityId: key,
      field: 'version',
      oldValue: previous ? { version: previous.version, definition: previous.definition } : null,
      newValue: { version, definition },
    });
    return row.id;
  });
  const [row] = await db.select().from(resultGroupRules).where(eq(resultGroupRules.id, id));
  return (await toVersions(db, [row]))[0];
}

/** Restore an old version by saving its definition as a new version. */
export async function restoreRuleVersion(db: Db, actor: Actor, key: ResultGroupKey, version: number): Promise<ResultGroupRuleVersion> {
  const [row] = await db.select().from(resultGroupRules).where(and(eq(resultGroupRules.key, key), eq(resultGroupRules.version, version)));
  if (!row) throw notFound('Version nicht gefunden');
  return saveRuleVersion(db, actor, key, row.definition);
}

export function ruleMeta() {
  return { fields: RULE_LEAD_FIELDS, inputs: RESULT_INPUT_KEYS.map((key) => ({ key, label: RESULT_INPUT_LABELS[key] })) };
}

// =====================================================================================================================
// Templates and objections
// =====================================================================================================================

function toTemplate(r: typeof templates.$inferSelect): Template {
  return { id: r.id, key: r.key, label: r.label, kind: r.kind, subject: r.subject, body: r.body, updatedBy: r.updatedBy, updatedAt: r.updatedAt.toISOString() };
}

export async function listTemplates(db: Db): Promise<Template[]> {
  return (await db.select().from(templates).orderBy(asc(templates.kind), asc(templates.label))).map(toTemplate);
}

export const templateUpdateSchema = z.strictObject({
  label: plainText(120).refine((v) => v.trim().length > 0, 'Name fehlt').optional(),
  subject: plainText(300).nullable().optional(),
  body: plainText(10_000),
});

export async function updateTemplate(db: Db, actor: Actor, id: string, input: z.infer<typeof templateUpdateSchema>): Promise<Template> {
  const [row] = await db.select().from(templates).where(eq(templates.id, id));
  if (!row) throw notFound('Vorlage nicht gefunden');
  const subject = input.subject === undefined ? row.subject : input.subject;
  const problems = validateTemplateText(row.kind, { subject, body: input.body });
  if (problems.length) throw unprocessable(problems.join(' · '), 'template_invalid');
  const label = input.label?.trim() ?? row.label;
  const [updated] = await db.update(templates).set({ label, subject, body: input.body, updatedBy: actor.userId, updatedAt: new Date() }).where(eq(templates.id, id)).returning();
  await audit(db, {
    actor,
    action: 'admin.template_update',
    entity: 'template',
    entityId: row.key,
    oldValue: { label: row.label, subject: row.subject, body: row.body },
    newValue: { label, subject, body: input.body },
  });
  return toTemplate(updated);
}

function toObjection(r: typeof objections.$inferSelect): ObjectionAnswer {
  return { id: r.id, key: r.key, label: r.label, answer: r.answer, sortOrder: r.sortOrder, active: r.isActive };
}

export async function listObjections(db: Db): Promise<ObjectionAnswer[]> {
  return (await db.select().from(objections).orderBy(asc(objections.sortOrder), asc(objections.label))).map(toObjection);
}

export const objectionSchema = z.strictObject({
  label: plainText(120).refine((v) => v.trim().length > 0, 'Einwand fehlt'),
  answer: plainText(2000).refine((v) => v.trim().length > 0, 'Antwort fehlt'),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  active: z.boolean().optional(),
});

export function slugKey(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return base || 'einwand';
}

export async function createObjection(db: Db, actor: Actor, input: z.infer<typeof objectionSchema>): Promise<ObjectionAnswer> {
  const existingKeys = new Set((await db.select({ key: objections.key }).from(objections)).map((r) => r.key));
  const base = slugKey(input.label);
  let key = base;
  for (let i = 2; existingKeys.has(key); i++) key = `${base}_${i}`;
  const [{ maxSort }] = await db.select({ maxSort: max(objections.sortOrder) }).from(objections);
  const [row] = await db
    .insert(objections)
    .values({ key, label: input.label.trim(), answer: input.answer.trim(), sortOrder: input.sortOrder ?? (maxSort ?? 0) + 10, isActive: input.active ?? true, updatedBy: actor.userId })
    .returning();
  await audit(db, { actor, action: 'admin.objection_create', entity: 'objection', entityId: key, newValue: { label: row.label, answer: row.answer } });
  return toObjection(row);
}

export async function updateObjection(db: Db, actor: Actor, id: string, input: Partial<z.infer<typeof objectionSchema>>): Promise<ObjectionAnswer> {
  const [row] = await db.select().from(objections).where(eq(objections.id, id));
  if (!row) throw notFound('Einwand nicht gefunden');
  const next = {
    label: input.label?.trim() ?? row.label,
    answer: input.answer?.trim() ?? row.answer,
    sortOrder: input.sortOrder ?? row.sortOrder,
    isActive: input.active ?? row.isActive,
  };
  const [updated] = await db.update(objections).set({ ...next, updatedBy: actor.userId, updatedAt: new Date() }).where(eq(objections.id, id)).returning();
  await audit(db, {
    actor,
    action: 'admin.objection_update',
    entity: 'objection',
    entityId: row.key,
    oldValue: { label: row.label, answer: row.answer, sortOrder: row.sortOrder, active: row.isActive },
    newValue: { label: next.label, answer: next.answer, sortOrder: next.sortOrder, active: next.isActive },
  });
  return toObjection(updated);
}

// =====================================================================================================================
// Booking rules and settings
// =====================================================================================================================

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Zeit im Format HH:MM');
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const timeWindow = z.strictObject({ from: hhmm, to: hhmm }).refine((w) => toMin(w.from) < toMin(w.to), 'Beginn muss vor dem Ende liegen');

export const bookingRulesSchema = z
  .strictObject({
    startWindows: z.array(timeWindow).min(1, 'Mindestens ein Zeitfenster').max(6),
    blockedWindows: z.array(timeWindow).max(6),
    durationMinutes: z.number().int().min(15).max(240),
    bufferBeforeMinutes: z.number().int().min(0).max(120),
    bufferAfterMinutes: z.number().int().min(0).max(120),
    slotStepMinutes: z.number().int().min(5).max(120),
    defaultSalesEmail: email,
    specialistEmail: email,
    extraCallSalesEmail: email,
    subjectTemplate: plainText(300).refine((v) => v.trim().length > 0, 'Betreff fehlt'),
    outlookCategory: plainText(80).refine((v) => v.trim().length > 0, 'Kategorie fehlt'),
    briefingCategory: plainText(80).refine((v) => v.trim().length > 0, 'Kategorie fehlt'),
    briefingMailDaysBefore: z.number().int().min(0).max(30),
    timezone: z.literal('Europe/Zurich'),
  })
  .superRefine((r, ctx) => {
    // A meeting starting anywhere in a start window must not run into a blocked window (e.g. 12:30–14:00).
    r.startWindows.forEach((w, i) => {
      const s = toMin(w.from);
      const e = toMin(w.to) + r.durationMinutes;
      if (r.blockedWindows.some((b) => s < toMin(b.to) && toMin(b.from) < e)) {
        ctx.addIssue({ code: 'custom', path: ['startWindows', i], message: 'Termine aus diesem Fenster würden in eine Sperrzeit fallen' });
      }
    });
    const problems = validateTemplateText('subject', { body: r.subjectTemplate });
    if (problems.length) ctx.addIssue({ code: 'custom', path: ['subjectTemplate'], message: problems.join(' · ') });
  });

export async function getBookingRules(db: Db): Promise<BookingRules> {
  return getSetting(db, 'booking.rules');
}

export async function updateBookingRules(db: Db, actor: Actor, rules: BookingRules): Promise<BookingRules> {
  const current = await getBookingRules(db);
  if (JSON.stringify(current) !== JSON.stringify(rules)) await setSetting(db, 'booking.rules', rules, actor);
  return getBookingRules(db);
}

export const adminSettingsSchema = z.strictObject({
  transcriptRetentionDays: z.number().int().min(1).max(365),
  analysisTimeoutMinutes: z.number().int().min(5).max(240),
  aiMonthlyBudgetUsd: z.number().min(0).max(100_000),
  notReachedMailThreshold: z.strictObject({ attempts: z.number().int().min(1).max(10), withinDays: z.number().int().min(1).max(90) }),
  campaignLockMonths: z.number().int().min(1).max(24),
  tasksMaxPerPersonPerDay: z.number().int().min(1).max(20),
  weeklyReportRecipient: email.nullable(),
  weeklyReportSender: email.nullable(),
});

export async function getAdminSettings(db: Db): Promise<AdminSettings> {
  const s = await getAllSettings(db);
  return {
    transcriptRetentionDays: s['transcripts.retentionDays'],
    analysisTimeoutMinutes: s['analysis.timeoutMinutes'],
    aiMonthlyBudgetUsd: s['ai.monthlyBudgetUsd'],
    notReachedMailThreshold: s['calls.notReachedMailThreshold'],
    campaignLockMonths: s['campaign.lockMonths'],
    tasksMaxPerPersonPerDay: s['tasks.maxPerPersonPerDay'],
    weeklyReportRecipient: await getExtraSetting(db, 'weeklyReport.recipient'),
    weeklyReportSender: await getExtraSetting(db, 'weeklyReport.sender'),
  };
}

/** Writes only changed values (each change audited by setSetting / setExtraSetting). */
export async function updateAdminSettings(db: Db, actor: Actor, patch: Partial<AdminSettings>): Promise<AdminSettings> {
  const current = await getAdminSettings(db);
  const changed = <K extends keyof AdminSettings>(k: K) => patch[k] !== undefined && JSON.stringify(patch[k]) !== JSON.stringify(current[k]);
  if (changed('transcriptRetentionDays')) await setSetting(db, 'transcripts.retentionDays', patch.transcriptRetentionDays!, actor);
  if (changed('analysisTimeoutMinutes')) await setSetting(db, 'analysis.timeoutMinutes', patch.analysisTimeoutMinutes!, actor);
  if (changed('aiMonthlyBudgetUsd')) await setSetting(db, 'ai.monthlyBudgetUsd', patch.aiMonthlyBudgetUsd!, actor);
  if (changed('notReachedMailThreshold')) await setSetting(db, 'calls.notReachedMailThreshold', patch.notReachedMailThreshold!, actor);
  if (changed('campaignLockMonths')) await setSetting(db, 'campaign.lockMonths', patch.campaignLockMonths!, actor);
  if (changed('tasksMaxPerPersonPerDay')) await setSetting(db, 'tasks.maxPerPersonPerDay', patch.tasksMaxPerPersonPerDay!, actor);
  if (changed('weeklyReportRecipient')) await setExtraSetting(db, 'weeklyReport.recipient', patch.weeklyReportRecipient ?? null, actor);
  if (changed('weeklyReportSender')) await setExtraSetting(db, 'weeklyReport.sender', patch.weeklyReportSender ?? null, actor);
  return getAdminSettings(db);
}

// =====================================================================================================================
// Connections / secrets
// =====================================================================================================================

export const SECRET_WARNING_DAYS = 30;

/** Status of a secret by its admin-entered expiry date (warning 30 days before). */
export function secretStatus(expiresOn: string | null | undefined, now: Date): Pick<SecretExpiry, 'status' | 'daysLeft'> {
  if (!expiresOn) return { status: 'unknown', daysLeft: null };
  const today = Date.parse(`${zurichDate(now)}T00:00:00Z`);
  const daysLeft = Math.round((Date.parse(`${expiresOn}T00:00:00Z`) - today) / 86_400_000);
  if (daysLeft < 0) return { status: 'expired', daysLeft };
  if (daysLeft <= SECRET_WARNING_DAYS) return { status: 'warning', daysLeft };
  return { status: 'ok', daysLeft };
}

const ADAPTER_LABELS: Record<keyof AppConfig['adapters'], string> = {
  crm: 'CRM (Dataverse)',
  calendar: 'Kalender (Microsoft Graph)',
  mail: 'Mail (Microsoft Graph)',
  ai: 'KI (Claude)',
  transcripts: 'Transkripte (Vera)',
  telephony: 'Telefonie (Teams)',
};

export function secretDefs(config: AppConfig): { name: SecretName; label: string; configured: boolean }[] {
  const graphLive = config.adapters.calendar === 'live' || config.adapters.mail === 'live';
  return [
    { name: 'entra_client_secret', label: 'Entra-App: Client-Geheimnis (Anmeldung, CRM)', configured: !!config.auth.entra },
    { name: 'entra_certificate', label: 'Entra-App: Zertifikat/Geheimnis für Hintergrundaufgaben', configured: graphLive },
    { name: 'anthropic_api_key', label: 'Claude: API-Schlüssel', configured: !!config.ai.apiKey },
    { name: 'vera_api_key', label: 'Vera: API-Schlüssel', configured: !!config.vera.apiKey },
  ];
}

export async function getConnections(db: Db, config: AppConfig, now: Date): Promise<AdminConnections> {
  const expiry = await getExtraSetting(db, 'secrets.expiry');
  return {
    environment: config.environmentLabel,
    authMode: config.auth.mode,
    integrations: config.integrationsMode,
    adapters: (Object.keys(ADAPTER_LABELS) as (keyof AppConfig['adapters'])[]).map((name) => ({ name, label: ADAPTER_LABELS[name], mode: config.adapters[name] })),
    mailTestRecipient: !!config.mailTestRecipient,
    secrets: secretDefs(config).map((d) => ({ ...d, expiresOn: expiry[d.name] ?? null, ...secretStatus(expiry[d.name], now) })),
  };
}

export const secretExpirySchema = z.strictObject({ expiresOn: isoDate.nullable() });

export async function setSecretExpiry(db: Db, actor: Actor, name: SecretName, expiresOn: string | null): Promise<void> {
  const current = await getExtraSetting(db, 'secrets.expiry');
  await setExtraSetting(db, 'secrets.expiry', { ...current, [name]: expiresOn }, actor);
}

/** Notify active admins once per secret/expiry/status when a secret is about to expire (job, daily). */
export async function notifySecretExpiry(db: Db, config: AppConfig, now: Date): Promise<number> {
  const stateKey = 'admin.secretExpiryNotified';
  const conns = await getConnections(db, config, now);
  const [stateRow] = await db.select().from(syncState).where(eq(syncState.key, stateKey));
  const state = { ...((stateRow?.value as Record<string, string> | undefined) ?? {}) };
  const due = conns.secrets.filter((s) => (s.status === 'warning' || s.status === 'expired') && state[s.name] !== `${s.expiresOn}:${s.status}`);
  if (!due.length) return 0;
  const admins = await activeAdminIds(db);
  for (const s of due) {
    const title = s.status === 'expired' ? `Abgelaufen: ${s.label}` : `Läuft in ${s.daysLeft} Tagen ab: ${s.label}`;
    if (admins.length) {
      await db.insert(notifications).values(
        admins.map((userId) => ({
          userId,
          kind: 'system',
          title,
          body: 'Bitte das Geheimnis erneuern und das neue Ablaufdatum im Admin unter «Verbindungen» eintragen.',
          link: '/admin',
          entity: 'secret',
          entityId: s.name,
          severity: s.status === 'expired' ? ('error' as const) : ('warning' as const),
        })),
      );
    }
    state[s.name] = `${s.expiresOn}:${s.status}`;
  }
  await db
    .insert(syncState)
    .values({ key: stateKey, value: state, updatedAt: now })
    .onConflictDoUpdate({ target: syncState.key, set: { value: state, updatedAt: now } });
  await audit(db, { actor: 'system', action: 'admin.secret_expiry_notice', entity: 'secret', meta: { secrets: due.map((d) => d.name) } });
  return due.length;
}

// =====================================================================================================================
// Audit log browser and revert
// =====================================================================================================================

export const auditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
  actorUserId: z.string().uuid().optional(),
  /** Exact action or prefix with trailing `.` (e.g. `crm.`). */
  action: z
    .string()
    .max(80)
    .regex(/^[a-z_.]+$/)
    .optional(),
  entity: z
    .string()
    .max(60)
    .regex(/^[a-z_]+$/)
    .optional(),
  entityId: z.string().max(120).optional(),
  changeSetId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

export type AuditListItem = AuditEntry & { revertable: boolean };

/** Field changes on leads can be reverted (as a new change set that must be approved). */
export function isRevertable(e: Pick<AuditEntry, 'action' | 'entity' | 'entityId' | 'field'>): boolean {
  return e.action === 'crm.field_update' && e.entity === 'lead' && !!e.entityId && !!e.field;
}

function toAuditEntry(r: typeof auditLog.$inferSelect): AuditListItem {
  const e: AuditEntry = {
    id: r.id,
    at: r.at.toISOString(),
    actorUserId: r.actorUserId,
    actorLabel: r.actorLabel,
    action: r.action,
    entity: r.entity,
    entityId: r.entityId,
    field: r.field,
    oldValue: r.oldValue,
    newValue: r.newValue,
    changeSetId: r.changeSetId,
    meta: r.meta,
  };
  return { ...e, revertable: isRevertable(e) };
}

export async function listAudit(db: Db, q: z.infer<typeof auditQuerySchema>): Promise<Paged<AuditListItem>> {
  const where: SQL[] = [];
  if (q.actorUserId) where.push(eq(auditLog.actorUserId, q.actorUserId));
  if (q.action) where.push(q.action.endsWith('.') ? ilike(auditLog.action, `${q.action}%`) : eq(auditLog.action, q.action));
  if (q.entity) where.push(eq(auditLog.entity, q.entity));
  if (q.entityId) where.push(eq(auditLog.entityId, q.entityId));
  if (q.changeSetId) where.push(eq(auditLog.changeSetId, q.changeSetId));
  if (q.from) where.push(gte(auditLog.at, new Date(q.from)));
  if (q.to) where.push(lt(auditLog.at, new Date(q.to)));
  const cond = where.length ? and(...where) : undefined;
  const [{ total }] = await db.select({ total: count() }).from(auditLog).where(cond);
  const rows = await db
    .select()
    .from(auditLog)
    .where(cond)
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  return { items: rows.map(toAuditEntry), total: Number(total), page: q.page, pageSize: q.pageSize };
}

export async function auditFacets(db: Db): Promise<{ actions: string[]; entities: string[]; actors: { id: string; name: string }[] }> {
  const actions = await db.selectDistinct({ v: auditLog.action }).from(auditLog).orderBy(asc(auditLog.action));
  const entities = await db.selectDistinct({ v: auditLog.entity }).from(auditLog).orderBy(asc(auditLog.entity));
  const actors = await db
    .selectDistinct({ id: auditLog.actorUserId, name: auditLog.actorLabel })
    .from(auditLog)
    .where(isNotNull(auditLog.actorUserId))
    .orderBy(asc(auditLog.actorLabel));
  return {
    actions: actions.map((a) => a.v),
    entities: entities.map((e) => e.v),
    actors: actors.filter((a): a is { id: string; name: string } => !!a.id),
  };
}

/**
 * «Zurücksetzen» of a lead field change: creates a NEW change set (kind `manual`, status `draft`) with the old value as
 * the new value. Nothing is written to the CRM here – the change set goes through the normal preview, conflict check
 * and approval of the changesets module.
 */
export async function proposeRevert(db: Db, adapters: Adapters, actor: Actor, auditId: number): Promise<{ changeSetId: string }> {
  const [row] = await db.select().from(auditLog).where(eq(auditLog.id, auditId));
  if (!row) throw notFound('Protokolleintrag nicht gefunden');
  const entry = toAuditEntry(row);
  if (!entry.revertable || !entry.entityId || !entry.field) throw unprocessable('Dieser Eintrag lässt sich nicht zurücksetzen.', 'not_revertable');
  const leadId = entry.entityId;
  const field = entry.field;
  const now = await adapters.crm.getFieldValues('lead', leadId, [field]);
  if (!(field in now)) throw notFound('Lead im CRM nicht gefunden');
  const crmNow = now[field];
  if (JSON.stringify(crmNow ?? null) === JSON.stringify(entry.oldValue ?? null)) {
    throw conflict('Das Feld hat im CRM bereits den alten Wert.', 'already_reverted');
  }
  const label = RULE_LEAD_FIELDS.find((f) => f.field === field)?.label ?? field;
  const [cs] = await db
    .insert(changeSets)
    .values({
      leadId,
      kind: 'manual',
      status: 'draft',
      operations: [{ id: randomUUID(), entity: 'lead', entityId: leadId, field, label, oldValue: crmNow, newValue: entry.oldValue, mode: 'set' }],
      baseSnapshot: { [snapshotKey('lead', leadId, field)]: crmNow },
      createdBy: actor.userId!,
    })
    .returning({ id: changeSets.id });
  await audit(db, {
    actor,
    action: 'admin.revert_proposed',
    entity: 'lead',
    entityId: leadId,
    field,
    oldValue: crmNow,
    newValue: entry.oldValue,
    changeSetId: cs.id,
    meta: { auditId },
  });
  return { changeSetId: cs.id };
}

// =====================================================================================================================
// Errors (failed change sets, failed jobs)
// =====================================================================================================================

export async function listErrors(db: Db): Promise<AdminErrorItem[]> {
  const failedSets = await db
    .select({ id: changeSets.id, kind: changeSets.kind, leadId: changeSets.leadId, error: changeSets.error, at: changeSets.updatedAt, actor: users.displayName })
    .from(changeSets)
    .leftJoin(users, eq(users.id, changeSets.createdBy))
    .where(eq(changeSets.status, 'failed'))
    .orderBy(desc(changeSets.updatedAt))
    .limit(100);
  const failedJobs = await db
    .select({ id: jobs.id, type: jobs.type, status: jobs.status, error: jobs.lastError, attempts: jobs.attempts, at: jobs.updatedAt, payload: jobs.payload })
    .from(jobs)
    .where(and(isNotNull(jobs.lastError), inArray(jobs.status, ['dead', 'failed', 'queued'])))
    .orderBy(desc(jobs.updatedAt))
    .limit(100);
  const items: AdminErrorItem[] = [
    ...failedSets.map((c) => ({
      id: c.id,
      source: 'change_set' as const,
      title: `CRM-Push fehlgeschlagen (${c.kind})`,
      error: c.error,
      at: c.at.toISOString(),
      leadId: c.leadId,
      actorName: c.actor ?? null,
      attempts: null,
      retryable: false,
    })),
    ...failedJobs.map((j) => ({
      id: String(j.id),
      source: 'job' as const,
      title: j.status === 'dead' ? `Hintergrundjob abgebrochen: ${j.type}` : `Hintergrundjob wird wiederholt: ${j.type}`,
      error: j.error,
      at: j.at.toISOString(),
      leadId: typeof j.payload?.leadId === 'string' ? j.payload.leadId : null,
      actorName: null,
      attempts: j.attempts,
      retryable: j.status === 'dead' || j.status === 'failed',
    })),
  ];
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

export async function retryJob(db: Db, actor: Actor, id: number): Promise<void> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (!job) throw notFound('Job nicht gefunden');
  if (job.status !== 'dead' && job.status !== 'failed') throw conflict('Dieser Job läuft noch oder ist schon fertig.', 'job_not_failed');
  try {
    await db.update(jobs).set({ status: 'queued', attempts: 0, runAt: new Date(), lockedAt: null, lockedBy: null, finishedAt: null, updatedAt: new Date() }).where(eq(jobs.id, id));
  } catch {
    throw conflict('Ein gleicher Job wartet bereits.', 'job_duplicate');
  }
  await audit(db, { actor, action: 'admin.job_retry', entity: 'job', entityId: String(id), meta: { type: job.type } });
}
