import { DEFAULT_RESULT_GROUP_RULES, zurichDate, type ResultGroupRule } from '@sales-portal/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/helpers';
import { DEFAULT_BOOKING_RULES, DEFAULT_TEMPLATES } from '../../db/seed/defaults';
import { DEMO_USERS } from '../../db/seed/users';
import { auditLog, changeSets, jobs, mockCrmLeads, notifications } from '../../db/schema';
import { resultGroupRuleSchema } from './ruleSchema';
import { bookingRulesSchema, notifySecretExpiry, roleChangeProblem, secretStatus, slugKey } from './service';
import { validateTemplateText } from './templates';

const id = (key: 'lukas' | 'markus' | 'manuel' | 'nico') => DEMO_USERS.find((u) => u.key === key)!.id;
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const rule = (key: string): ResultGroupRule => clone(DEFAULT_RESULT_GROUP_RULES.find((r) => r.key === key)!);

// =====================================================================================================================
// Business rules (pure)
// =====================================================================================================================

describe('role change rules', () => {
  const admins = ['A', 'B'];
  it('nobody removes their own admin role', () => {
    expect(roleChangeProblem({ actorId: 'A', targetId: 'A', currentRoles: ['admin', 'sales'], nextRoles: ['sales'], activeAdminIds: admins })).toMatch(/eigene Admin-Rolle/);
    expect(roleChangeProblem({ actorId: 'A', targetId: 'A', currentRoles: ['admin'], nextRoles: ['admin', 'sales'], activeAdminIds: admins })).toBeNull();
  });
  it('the last active admin keeps the role; others may lose it', () => {
    expect(roleChangeProblem({ actorId: 'A', targetId: 'B', currentRoles: ['admin'], nextRoles: [], activeAdminIds: ['B'] })).toMatch(/mindestens ein aktiver Admin/);
    expect(roleChangeProblem({ actorId: 'A', targetId: 'B', currentRoles: ['admin'], nextRoles: [], activeAdminIds: admins })).toBeNull();
  });
});

describe('result-group rule validation (shared ResultGroupRule)', () => {
  it('accepts all default rules v1 (INTENT 6.5)', () => {
    for (const r of DEFAULT_RESULT_GROUP_RULES) {
      const res = resultGroupRuleSchema.safeParse(r);
      expect(res.success, `${r.key}: ${res.success ? '' : JSON.stringify(res.error.issues)}`).toBe(true);
    }
  });

  it('rejects unknown codes, wrong action/field combinations and unknown properties', () => {
    const bad = (mut: (r: ResultGroupRule & Record<string, unknown>) => void) => {
      const r = rule('info_mail') as ResultGroupRule & Record<string, unknown>;
      mut(r);
      return resultGroupRuleSchema.safeParse(r).success;
    };
    expect(bad(() => {})).toBe(true);
    expect(bad((r) => (r.anrufergebnis = 123))).toBe(false);
    expect(bad((r) => (r.callStatus = { mode: 'fixed', value: 999 }))).toBe(false);
    expect(bad((r) => (r.callStatus = { mode: 'fixed' }))).toBe(false);
    expect(bad((r) => r.fieldActions.push({ kind: 'add_to_multiselect', field: 'subject', value: 'x' }))).toBe(false);
    expect(bad((r) => r.fieldActions.push({ kind: 'set', field: 'kls_interests', value: 845140014 }))).toBe(false);
    expect(bad((r) => r.fieldActions.push({ kind: 'set', field: 'kls_lead_support', value: 42 }))).toBe(false);
    expect(bad((r) => r.fieldActions.push({ kind: 'set', field: 'donotphone', value: 'ja' }))).toBe(false);
    expect(bad((r) => r.fieldActions.push({ kind: 'set', field: 'statecode' as never, value: 2 }))).toBe(false);
    expect(bad((r) => r.fieldActions.push({ kind: 'disqualify' }))).toBe(false);
    expect(bad((r) => r.fieldActions.push({ kind: 'disqualify', statuscode: 6 }))).toBe(true);
    expect(bad((r) => r.fieldActions.push({ kind: 'note', text: '   ' }))).toBe(false);
    expect(bad((r) => r.fieldActions.push({ kind: 'task' }))).toBe(false);
    expect(bad((r) => (r.label = '<img src=x onerror=alert(1)>'))).toBe(false);
    expect(bad((r) => (r.evil = true))).toBe(false);
  });

  it('by-date call status: ascending limits, last step «später»', () => {
    const r = rule('callback');
    expect(resultGroupRuleSchema.safeParse(r).success).toBe(true);
    r.callStatus.byDate = [
      { maxDays: 7, value: 845140004 },
      { maxDays: 1, value: 845140003 },
      { maxDays: null, value: 845140010 },
    ];
    expect(resultGroupRuleSchema.safeParse(r).success).toBe(false);
    r.callStatus.byDate = [{ maxDays: 1, value: 845140003 }];
    expect(resultGroupRuleSchema.safeParse(r).success).toBe(false);
  });
});

describe('templates: plain text with known placeholders', () => {
  it('accepts every default template', () => {
    for (const t of DEFAULT_TEMPLATES) expect(validateTemplateText(t.kind, t), t.key).toEqual([]);
  });
  it('rejects HTML, unknown placeholders and broken braces', () => {
    expect(validateTemplateText('mail', { subject: 'Hallo', body: 'Text <b>fett</b>' })[0]).toMatch(/HTML/);
    expect(validateTemplateText('subject', { body: '{Firma} {Passwort}' })[0]).toMatch(/\{Passwort\}/);
    expect(validateTemplateText('subject', { body: '{Firma' })[0]).toMatch(/Klammern/);
    expect(validateTemplateText('mail', { subject: 'x', body: 'a < b und c > d' })).toEqual([]);
  });
});

describe('booking rules validation', () => {
  it('accepts the defaults (INTENT 6.6)', () => {
    expect(bookingRulesSchema.safeParse(DEFAULT_BOOKING_RULES).success).toBe(true);
  });
  it('rejects start windows that run into the lunch block and reversed windows', () => {
    expect(bookingRulesSchema.safeParse({ ...DEFAULT_BOOKING_RULES, startWindows: [{ from: '09:00', to: '12:30' }] }).success).toBe(false);
    expect(bookingRulesSchema.safeParse({ ...DEFAULT_BOOKING_RULES, startWindows: [{ from: '11:00', to: '09:00' }] }).success).toBe(false);
    expect(bookingRulesSchema.safeParse({ ...DEFAULT_BOOKING_RULES, durationMinutes: 5 }).success).toBe(false);
  });
});

describe('secret expiry', () => {
  const now = new Date('2026-11-20T10:00:00Z');
  it('warns 30 days before, marks expired, unknown without date', () => {
    expect(secretStatus(null, now)).toEqual({ status: 'unknown', daysLeft: null });
    expect(secretStatus('2027-01-31', now)).toEqual({ status: 'ok', daysLeft: 72 });
    expect(secretStatus('2026-12-20', now)).toEqual({ status: 'warning', daysLeft: 30 });
    expect(secretStatus('2026-11-20', now)).toEqual({ status: 'warning', daysLeft: 0 });
    expect(secretStatus('2026-11-19', now)).toEqual({ status: 'expired', daysLeft: -1 });
  });
  it('objection keys are slugs', () => {
    expect(slugKey('Wir sind zufrieden – später!')).toBe('wir_sind_zufrieden_spaeter');
  });
});

// =====================================================================================================================
// API
// =====================================================================================================================

describe('admin API', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('only admins – and «Ansicht als» never escalates or keeps admin rights', async () => {
    for (const who of ['markus', 'manuel', 'nico'] as const) {
      const s = await t.login(who);
      expect((await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: s.cookie } })).statusCode).toBe(403);
      const w = await t.app.inject({ method: 'PUT', url: `/api/admin/users/${id(who)}/roles`, headers: json(s.headers), payload: { roles: ['admin'] } });
      expect(w.statusCode).toBe(403);
      // non-admins cannot use «Ansicht als» to become admin
      expect((await t.app.inject({ method: 'PUT', url: '/api/me/view-as', headers: json(s.headers), payload: { role: 'admin' } })).statusCode).toBe(403);
    }
    const lukas = await t.login('lukas', { fresh: true });
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: lukas.cookie } })).statusCode).toBe(200);
    await t.app.inject({ method: 'PUT', url: '/api/me/view-as', headers: json(lukas.headers), payload: { role: 'sales' } });
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: lukas.cookie } })).statusCode).toBe(403);
    const write = await t.app.inject({ method: 'PUT', url: '/api/admin/settings', headers: json(lukas.headers), payload: { transcriptRetentionDays: 10 } });
    expect(write.statusCode).toBe(403);
    await t.app.inject({ method: 'DELETE', url: '/api/me/view-as', headers: lukas.headers });
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: lukas.cookie } })).statusCode).toBe(200);
  });

  it('assigns and removes roles (audited), blocks removing the own admin role', async () => {
    const lukas = await t.login('lukas');
    const res = await t.app.inject({ method: 'PUT', url: `/api/admin/users/${id('manuel')}/roles`, headers: json(lukas.headers), payload: { roles: ['sales', 'ai_specialist'] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().roles).toEqual(['sales', 'ai_specialist']);
    const grants = await t.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'admin.role_grant'), eq(auditLog.entityId, id('manuel'))));
    expect(grants.map((g) => g.newValue)).toContain('ai_specialist');
    const back = await t.app.inject({ method: 'PUT', url: `/api/admin/users/${id('manuel')}/roles`, headers: json(lukas.headers), payload: { roles: ['sales'] } });
    expect(back.json().roles).toEqual(['sales']);
    expect((await t.ctx.db.select().from(auditLog).where(eq(auditLog.action, 'admin.role_revoke'))).length).toBe(1);

    const self = await t.app.inject({ method: 'PUT', url: `/api/admin/users/${id('lukas')}/roles`, headers: json(lukas.headers), payload: { roles: ['sales'] } });
    expect(self.statusCode).toBe(422);
    expect(self.json().error.message).toMatch(/eigene Admin-Rolle/);
    const invalid = await t.app.inject({ method: 'PUT', url: `/api/admin/users/${id('nico')}/roles`, headers: json(lukas.headers), payload: { roles: ['superuser'] } });
    expect(invalid.statusCode).toBe(400);
  });

  it('adds a user by email for the Entra login; duplicates and invalid input are rejected', async () => {
    const lukas = await t.login('lukas');
    const res = await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: json(lukas.headers), payload: { email: 'Neu.Person@Example.ch', displayName: 'Neue Person', roles: ['sales'] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email: 'neu.person@example.ch', roles: ['sales'], isActive: true });
    const dup = await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: json(lukas.headers), payload: { email: 'neu.person@example.ch', displayName: 'X Y', roles: [] } });
    expect(dup.statusCode).toBe(409);
    const bad = await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: json(lukas.headers), payload: { email: 'kein-mail', displayName: 'X Y' } });
    expect(bad.statusCode).toBe(400);
  });

  it('deactivating a user ends their sessions; the own access cannot be deactivated', async () => {
    const lukas = await t.login('lukas');
    const nico = await t.login('nico', { fresh: true });
    const off = await t.app.inject({ method: 'PUT', url: `/api/admin/users/${id('nico')}/active`, headers: json(lukas.headers), payload: { isActive: false } });
    expect(off.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: nico.cookie } })).statusCode).toBe(401);
    await t.app.inject({ method: 'PUT', url: `/api/admin/users/${id('nico')}/active`, headers: json(lukas.headers), payload: { isActive: true } });
    const self = await t.app.inject({ method: 'PUT', url: `/api/admin/users/${id('lukas')}/active`, headers: json(lukas.headers), payload: { isActive: false } });
    expect(self.statusCode).toBe(422);
  });

  it('saving a rule creates a new version, keeps the old one, restore = another new version', async () => {
    const lukas = await t.login('lukas');
    const list = await t.app.inject({ method: 'GET', url: '/api/admin/rules', headers: { cookie: lukas.cookie } });
    expect(list.json().items).toHaveLength(15);
    expect(list.json().meta.fields.length).toBeGreaterThan(5);

    const def = { ...rule('waiting'), label: 'Wartet auf Antwort', followUp: { type: 'task', offsetDays: 5, taskSubject: 'Nachfassen {company}' } };
    const saved = await t.app.inject({ method: 'PUT', url: '/api/admin/rules/waiting', headers: json(lukas.headers), payload: { definition: { ...def, version: 99, key: 'callback' } } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ key: 'waiting', version: 2, isActive: true, label: 'Wartet auf Antwort', createdByName: 'Lukas' });
    expect(saved.json().definition.key).toBe('waiting');

    const versions = await t.app.inject({ method: 'GET', url: '/api/admin/rules/waiting/versions', headers: { cookie: lukas.cookie } });
    expect(versions.json().items.map((v: { version: number; isActive: boolean }) => [v.version, v.isActive])).toEqual([
      [2, true],
      [1, false],
    ]);

    const invalid = await t.app.inject({
      method: 'PUT',
      url: '/api/admin/rules/waiting',
      headers: json(lukas.headers),
      payload: { definition: { ...def, callStatus: { mode: 'fixed', value: 1 } } },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.message).toMatch(/callStatus/);

    const restored = await t.app.inject({ method: 'POST', url: '/api/admin/rules/waiting/restore', headers: json(lukas.headers), payload: { version: 1 } });
    expect(restored.json()).toMatchObject({ version: 3, isActive: true, label: rule('waiting').label });
    const audits = await t.ctx.db.select().from(auditLog).where(eq(auditLog.action, 'admin.rule_version'));
    expect(audits).toHaveLength(2);
  });

  it('templates: plain text with placeholder help, HTML and unknown placeholders rejected, changes audited', async () => {
    const lukas = await t.login('lukas');
    const list = await t.app.inject({ method: 'GET', url: '/api/admin/templates', headers: { cookie: lukas.cookie } });
    const tpl = list.json().items.find((x: { key: string }) => x.key === 'mail.proposals');
    expect(tpl.placeholders.map((p: { name: string }) => p.name)).toContain('Vorschlaege');
    const html = await t.app.inject({ method: 'PUT', url: `/api/admin/templates/${tpl.id}`, headers: json(lukas.headers), payload: { body: 'Hallo <script>alert(1)</script>' } });
    expect(html.statusCode).toBe(400);
    const unknown = await t.app.inject({ method: 'PUT', url: `/api/admin/templates/${tpl.id}`, headers: json(lukas.headers), payload: { body: 'Hallo {Kontonummer}' } });
    expect(unknown.statusCode).toBe(422);
    const ok = await t.app.inject({ method: 'PUT', url: `/api/admin/templates/${tpl.id}`, headers: json(lukas.headers), payload: { subject: 'Termine – {Firma}', body: 'Guten Tag {Anrede} {Nachname}\n\n{Vorschlaege}' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().subject).toBe('Termine – {Firma}');
    const [a] = await t.ctx.db.select().from(auditLog).where(eq(auditLog.action, 'admin.template_update'));
    expect(a.entityId).toBe('mail.proposals');
  });

  it('objections: create and deactivate (audited)', async () => {
    const lukas = await t.login('lukas');
    const created = await t.app.inject({ method: 'POST', url: '/api/admin/objections', headers: json(lukas.headers), payload: { label: 'Schicken Sie mir Unterlagen', answer: 'Gerne – damit sie passen: Wo drückt es am meisten?' } });
    expect(created.statusCode).toBe(200);
    const upd = await t.app.inject({ method: 'PUT', url: `/api/admin/objections/${created.json().id}`, headers: json(lukas.headers), payload: { active: false } });
    expect(upd.json().active).toBe(false);
    const audits = await t.ctx.db.select().from(auditLog).where(eq(auditLog.entity, 'objection'));
    expect(audits.map((x) => x.action).sort()).toEqual(['admin.objection_create', 'admin.objection_update']);
  });

  it('booking rules and settings are validated and audited', async () => {
    const lukas = await t.login('lukas');
    const bad = await t.app.inject({ method: 'PUT', url: '/api/admin/booking-rules', headers: json(lukas.headers), payload: { ...DEFAULT_BOOKING_RULES, startWindows: [{ from: '09:00', to: '13:00' }] } });
    expect(bad.statusCode).toBe(400);
    const ok = await t.app.inject({ method: 'PUT', url: '/api/admin/booking-rules', headers: json(lukas.headers), payload: { ...DEFAULT_BOOKING_RULES, bufferAfterMinutes: 15 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().bufferAfterMinutes).toBe(15);

    const s = await t.app.inject({ method: 'PUT', url: '/api/admin/settings', headers: json(lukas.headers), payload: { transcriptRetentionDays: 45, aiMonthlyBudgetUsd: 80, weeklyReportRecipient: 'sales.demo@example.ch' } });
    expect(s.statusCode).toBe(200);
    expect(s.json()).toMatchObject({ transcriptRetentionDays: 45, aiMonthlyBudgetUsd: 80, weeklyReportRecipient: 'sales.demo@example.ch', analysisTimeoutMinutes: 30 });
    expect((await t.app.inject({ method: 'PUT', url: '/api/admin/settings', headers: json(lukas.headers), payload: { transcriptRetentionDays: 0 } })).statusCode).toBe(400);
    const keys = (await t.ctx.db.select().from(auditLog).where(eq(auditLog.action, 'admin.setting_update'))).map((x) => x.entityId);
    expect(keys).toEqual(expect.arrayContaining(['booking.rules', 'transcripts.retentionDays', 'ai.monthlyBudgetUsd', 'weeklyReport.recipient']));
    expect(keys).not.toContain('analysis.timeoutMinutes'); // unchanged values are not written
  });

  it('connections: modes and environment visible, secret expiry warns 30 days before (once)', async () => {
    const lukas = await t.login('lukas');
    const conn = await t.app.inject({ method: 'GET', url: '/api/admin/connections', headers: { cookie: lukas.cookie } });
    expect(conn.json()).toMatchObject({ environment: 'Demo', authMode: 'dev', integrations: 'mock' });
    expect(conn.body).not.toMatch(/secret-value|sk-ant/);
    const soon = zurichDate(new Date(Date.now() + 10 * 86_400_000));
    const put = await t.app.inject({ method: 'PUT', url: '/api/admin/connections/secrets/anthropic_api_key', headers: json(lukas.headers), payload: { expiresOn: soon } });
    expect(put.json().secrets.find((x: { name: string }) => x.name === 'anthropic_api_key')).toMatchObject({ status: 'warning', expiresOn: soon });
    expect((await t.app.inject({ method: 'PUT', url: '/api/admin/connections/secrets/unknown', headers: json(lukas.headers), payload: { expiresOn: soon } })).statusCode).toBe(400);
    expect(await notifySecretExpiry(t.ctx.db, t.ctx.config, new Date())).toBe(1);
    expect(await notifySecretExpiry(t.ctx.db, t.ctx.config, new Date())).toBe(0);
    const notes = await t.ctx.db.select().from(notifications).where(eq(notifications.entityId, 'anthropic_api_key'));
    expect(notes.map((n) => n.userId)).toEqual([id('lukas')]);
  });

  it('audit log: filters and paging', async () => {
    const lukas = await t.login('lukas');
    const page = await t.app.inject({ method: 'GET', url: '/api/admin/audit?action=admin.&pageSize=10&page=1', headers: { cookie: lukas.cookie } });
    expect(page.statusCode).toBe(200);
    const body = page.json();
    expect(body.items.length).toBeLessThanOrEqual(10);
    expect(body.total).toBeGreaterThan(5);
    expect(body.items.every((x: { action: string }) => x.action.startsWith('admin.'))).toBe(true);
    const p2 = await t.app.inject({ method: 'GET', url: '/api/admin/audit?action=admin.&pageSize=10&page=2', headers: { cookie: lukas.cookie } });
    expect(p2.json().items[0]?.id).not.toBe(body.items[0].id);
    expect((await t.app.inject({ method: 'GET', url: "/api/admin/audit?action=x'or 1=1", headers: { cookie: lukas.cookie } })).statusCode).toBe(400);
    const facets = await t.app.inject({ method: 'GET', url: '/api/admin/audit/facets', headers: { cookie: lukas.cookie } });
    expect(facets.json().actions).toContain('admin.role_grant');
  });

  it('revert of a lead field change creates a new change set that still needs approval', async () => {
    const lukas = await t.login('lukas');
    await t.ctx.db.insert(mockCrmLeads).values({ leadid: 'T-REV-1', companyname: 'Revert AG', kls_callstatus: 845140008 });
    const [entry] = await t.ctx.db
      .insert(auditLog)
      .values({ actorLabel: 'Markus', action: 'crm.field_update', entity: 'lead', entityId: 'T-REV-1', field: 'kls_callstatus', oldValue: 845140001, newValue: 845140008 })
      .returning();
    const list = await t.app.inject({ method: 'GET', url: '/api/admin/audit?entity=lead&entityId=T-REV-1', headers: { cookie: lukas.cookie } });
    expect(list.json().items[0]).toMatchObject({ revertable: true, oldValue: 845140001, newValue: 845140008 });

    const res = await t.app.inject({ method: 'POST', url: `/api/admin/audit/${entry.id}/revert`, headers: lukas.headers });
    expect(res.statusCode).toBe(200);
    const [cs] = await t.ctx.db.select().from(changeSets).where(eq(changeSets.id, res.json().changeSetId));
    expect(cs).toMatchObject({ leadId: 'T-REV-1', kind: 'manual', status: 'draft', createdBy: id('lukas') });
    expect(cs.operations[0]).toMatchObject({ field: 'kls_callstatus', oldValue: 845140008, newValue: 845140001, mode: 'set' });
    expect(cs.baseSnapshot).toEqual({ 'lead:T-REV-1:kls_callstatus': 845140008 });
    // CRM untouched until approved
    const [lead] = await t.ctx.db.select().from(mockCrmLeads).where(eq(mockCrmLeads.leadid, 'T-REV-1'));
    expect(lead.kls_callstatus).toBe(845140008);

    const notRevertable = (await t.ctx.db.select().from(auditLog).where(eq(auditLog.action, 'admin.role_grant')))[0];
    expect((await t.app.inject({ method: 'POST', url: `/api/admin/audit/${notRevertable.id}/revert`, headers: lukas.headers })).statusCode).toBe(422);
  });

  it('errors: failed jobs listed and retried (audited)', async () => {
    const lukas = await t.login('lukas');
    const [job] = await t.ctx.db.insert(jobs).values({ type: 'ai.analyze_call', status: 'dead', attempts: 3, lastError: 'Zeitüberschreitung', payload: { leadId: 'L1' } }).returning();
    const list = await t.app.inject({ method: 'GET', url: '/api/admin/errors', headers: { cookie: lukas.cookie } });
    expect(list.json().items.find((x: { id: string }) => x.id === String(job.id))).toMatchObject({ source: 'job', retryable: true, leadId: 'L1', error: 'Zeitüberschreitung' });
    const retry = await t.app.inject({ method: 'POST', url: `/api/admin/errors/jobs/${job.id}/retry`, headers: lukas.headers });
    expect(retry.statusCode).toBe(200);
    const [after] = await t.ctx.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(after).toMatchObject({ status: 'queued', attempts: 0 });
    expect((await t.app.inject({ method: 'POST', url: `/api/admin/errors/jobs/${job.id}/retry`, headers: lukas.headers })).statusCode).toBe(409);
    expect((await t.ctx.db.select().from(auditLog).where(eq(auditLog.action, 'admin.job_retry'))).length).toBe(1);
  });
});
