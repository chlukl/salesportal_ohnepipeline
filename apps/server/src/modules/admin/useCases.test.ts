import { USE_CASES } from '@sales-portal/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/helpers';
import { auditLog, settings } from '../../db/schema';
import { defaultUseCaseCatalog, sortUseCases, USE_CASE_SETTING_KEY, useCaseCreateSchema, useCaseIdSchema, useCaseLabelFrom, useCaseUpdateSchema } from './useCases';

const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });

describe('use-case catalog rules', () => {
  it('defaults mirror the built-in USE_CASES with short text and industries', () => {
    const list = defaultUseCaseCatalog();
    expect(list.map((u) => u.id)).toEqual(USE_CASES.map((u) => u.id));
    for (const u of list) {
      expect(u.builtIn).toBe(true);
      expect(u.active).toBe(true);
      expect(u.description.length).toBeGreaterThan(10);
      expect(u.industries.length).toBeGreaterThan(0);
    }
  });

  it('campaign keys are normalised to upper case and must be stable-key shaped', () => {
    expect(useCaseIdSchema.parse(' uc-test ')).toBe('UC-TEST');
    expect(useCaseIdSchema.safeParse('U').success).toBe(false);
    expect(useCaseIdSchema.safeParse('UC DOC').success).toBe(false);
    expect(useCaseIdSchema.safeParse('UC-').success).toBe(false);
    expect(useCaseIdSchema.safeParse('<b>X</b>').success).toBe(false);
    expect(useCaseIdSchema.safeParse('A'.repeat(41)).success).toBe(false);
  });

  it('texts are plain text, industries trimmed and de-duplicated', () => {
    const ok = useCaseCreateSchema.parse({ id: 'uc-x', label: ' Titel ', short: 'Kurz', industries: ['Bau', ' bau ', '  Holz   bau ', ''] });
    expect(ok).toMatchObject({ id: 'UC-X', label: 'Titel', description: '', active: true, industries: ['Bau', 'Holz bau'] });
    expect(useCaseCreateSchema.safeParse({ id: 'UC-X', label: '<img src=x onerror=alert(1)>', short: 'K' }).success).toBe(false);
    expect(useCaseCreateSchema.safeParse({ id: 'UC-X', label: '   ', short: 'K' }).success).toBe(false);
    expect(useCaseCreateSchema.safeParse({ id: 'UC-X', label: 'T', short: 'K', builtIn: false }).success).toBe(false);
    expect(useCaseUpdateSchema.safeParse({}).success).toBe(false);
    expect(useCaseUpdateSchema.safeParse({ id: 'UC-OTHER' }).success).toBe(false);
  });

  it('unknown campaign keys are labelled as unknown instead of showing a bare id; inactive entries sort last', () => {
    const list = defaultUseCaseCatalog();
    expect(useCaseLabelFrom(list, 'uc-doc')).toBe(USE_CASES[0].label);
    expect(useCaseLabelFrom(list, 'UC-NEU')).toBe('Unbekannter Use Case (UC-NEU)');
    list[0].active = false;
    expect(sortUseCases(list).at(-1)?.id).toBe(list[0].id);
  });
});

describe('use-case catalog API', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('read for Sales, AI-Spezialist and Admin; never for the Coldcaller', async () => {
    const markus = await t.login('markus');
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/use-cases', headers: { cookie: markus.cookie } })).statusCode).toBe(403);
    const manuel = await t.login('manuel');
    const sales = await t.app.inject({ method: 'GET', url: '/api/admin/use-cases', headers: { cookie: manuel.cookie } });
    expect(sales.statusCode).toBe(200);
    expect(sales.json().canEdit).toBe(false);
    expect(sales.json().items.map((u: { id: string }) => u.id)).toEqual(USE_CASES.map((u) => u.id));
    const nico = await t.login('nico');
    const ai = await t.app.inject({ method: 'GET', url: '/api/admin/use-cases', headers: { cookie: nico.cookie } });
    expect(ai.json().canEdit).toBe(true);
  });

  it('only AI-Spezialist and Admin edit; Sales and Coldcaller get 403', async () => {
    for (const who of ['markus', 'manuel'] as const) {
      const s = await t.login(who);
      const create = await t.app.inject({ method: 'POST', url: '/api/admin/use-cases', headers: json(s.headers), payload: { id: 'UC-HACK', label: 'X', short: 'X' } });
      expect(create.statusCode).toBe(403);
      const update = await t.app.inject({ method: 'PUT', url: '/api/admin/use-cases/UC-DOC', headers: json(s.headers), payload: { label: 'X' } });
      expect(update.statusCode).toBe(403);
    }
    // «Ansicht als» Sales takes the edit right away from the admin.
    const lukas = await t.login('lukas', { fresh: true });
    await t.app.inject({ method: 'PUT', url: '/api/me/view-as', headers: json(lukas.headers), payload: { role: 'sales' } });
    const asSales = await t.app.inject({ method: 'PUT', url: '/api/admin/use-cases/UC-DOC', headers: json(lukas.headers), payload: { label: 'X' } });
    expect(asSales.statusCode).toBe(403);
    await t.app.inject({ method: 'DELETE', url: '/api/me/view-as', headers: lukas.headers });
  });

  it('AI-Spezialist adds a use case with a new campaign key (audited); duplicates are rejected', async () => {
    const nico = await t.login('nico');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/admin/use-cases',
      headers: json(nico.headers),
      payload: { id: 'uc-lager', label: 'Lagerbestand automatisch abgleichen', short: 'Lager', description: 'Bestände aus Lieferscheinen nachführen.', industries: ['Logistik'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'UC-LAGER', builtIn: false, active: true, updatedByName: 'Nico' });
    const dup = await t.app.inject({ method: 'POST', url: '/api/admin/use-cases', headers: json(nico.headers), payload: { id: 'UC-LAGER', label: 'X', short: 'X' } });
    expect(dup.statusCode).toBe(409);
    const builtInDup = await t.app.inject({ method: 'POST', url: '/api/admin/use-cases', headers: json(nico.headers), payload: { id: 'uc-doc', label: 'X', short: 'X' } });
    expect(builtInDup.statusCode).toBe(409);
    const html = await t.app.inject({ method: 'POST', url: '/api/admin/use-cases', headers: json(nico.headers), payload: { id: 'UC-Y', label: '<script>x</script>', short: 'Y' } });
    expect(html.statusCode).toBe(400);

    const list = await t.app.inject({ method: 'GET', url: '/api/admin/use-cases', headers: { cookie: nico.cookie } });
    expect(list.json().items.map((u: { id: string }) => u.id)).toContain('UC-LAGER');
    const audits = await t.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'admin.use_case_create'), eq(auditLog.entityId, 'UC-LAGER')));
    expect(audits).toHaveLength(1);
  });

  it('edits texts and hides entries, never renames the key (audited old → new)', async () => {
    const nico = await t.login('nico');
    const res = await t.app.inject({ method: 'PUT', url: '/api/admin/use-cases/uc-doc', headers: json(nico.headers), payload: { short: 'Belege', active: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'UC-DOC', short: 'Belege', active: false, builtIn: true, label: USE_CASES[0].label });
    const rename = await t.app.inject({ method: 'PUT', url: '/api/admin/use-cases/UC-DOC', headers: json(nico.headers), payload: { id: 'UC-NEU' } });
    expect(rename.statusCode).toBe(400);
    const missing = await t.app.inject({ method: 'PUT', url: '/api/admin/use-cases/UC-GIBTSNICHT', headers: json(nico.headers), payload: { label: 'X' } });
    expect(missing.statusCode).toBe(404);

    const list = (await t.app.inject({ method: 'GET', url: '/api/admin/use-cases', headers: { cookie: nico.cookie } })).json().items as { id: string; active: boolean }[];
    expect(list.at(-1)).toMatchObject({ id: 'UC-DOC', active: false });
    const [audit] = await t.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'admin.use_case_update'), eq(auditLog.entityId, 'UC-DOC')));
    expect(audit.oldValue).toMatchObject({ short: USE_CASES[0].short, active: true });
    expect(audit.newValue).toMatchObject({ short: 'Belege', active: false });
  });

  it('a damaged stored catalog falls back to the defaults instead of failing', async () => {
    await t.ctx.db.update(settings).set({ value: [{ id: 'kaputt' }] }).where(eq(settings.key, USE_CASE_SETTING_KEY));
    const nico = await t.login('nico');
    const list = await t.app.inject({ method: 'GET', url: '/api/admin/use-cases', headers: { cookie: nico.cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(USE_CASES.length);
  });
});
