import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

const SECRET = 'x'.repeat(48);
const KEY = Buffer.alloc(32, 7).toString('base64');

const prodBase = {
  NODE_ENV: 'production',
  PUBLIC_URL: 'https://portal.intern.example',
  DATABASE_URL: 'postgres://sales_portal@db:5432/sales_portal',
  SESSION_SECRET: SECRET,
  TOKEN_ENC_KEY: KEY,
  AUTH_MODE: 'entra',
  ENTRA_TENANT_ID: '11111111-1111-1111-1111-111111111111',
  ENTRA_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
  ENTRA_CLIENT_SECRET: 'client-secret',
  INTEGRATIONS: 'live',
  DATAVERSE_URL: 'https://example.crm4.dynamics.com',
  ANTHROPIC_API_KEY: 'test-key',
  ENVIRONMENT_LABEL: 'Prod',
};

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
}

describe('config – production safety', () => {
  it('accepts a complete production configuration', () => {
    const config = loadConfig(prodBase);
    expect(config.isProd).toBe(true);
    expect(config.auth.mode).toBe('entra');
    expect(config.db.kind).toBe('pg');
    expect(config.allowedOrigins).toEqual(['https://portal.intern.example']);
    expect(config.auth.entra?.redirectUri).toBe('https://portal.intern.example/api/auth/callback');
  });

  it('refuses AUTH_MODE=dev in production', () => {
    expect(problemsOf({ ...prodBase, AUTH_MODE: 'dev' }).join()).toMatch(/AUTH_MODE=dev/);
  });

  it('refuses mock integrations in production without ALLOW_MOCK_IN_PRODUCTION', () => {
    expect(problemsOf({ ...prodBase, INTEGRATIONS: 'mock' }).join()).toMatch(/Mock-Integrationen/);
    expect(problemsOf({ ...prodBase, CRM_ADAPTER: 'mock' }).join()).toMatch(/Mock-Integrationen/);
    expect(problemsOf({ ...prodBase, INTEGRATIONS: 'mock', ALLOW_MOCK_IN_PRODUCTION: 'true' })).toEqual([]);
  });

  it('refuses a short or missing SESSION_SECRET', () => {
    expect(problemsOf({ ...prodBase, SESSION_SECRET: 'short' }).join()).toMatch(/32 Bytes/);
    expect(problemsOf({ ...prodBase, SESSION_SECRET: undefined }).join()).toMatch(/SESSION_SECRET fehlt/);
    // Also outside production when explicitly set too short.
    expect(problemsOf({ NODE_ENV: 'development', SESSION_SECRET: 'short' }).join()).toMatch(/32 Bytes/);
  });

  it('refuses http PUBLIC_URL, missing DB and missing Entra settings in production', () => {
    expect(problemsOf({ ...prodBase, PUBLIC_URL: 'http://portal.intern.example' }).join()).toMatch(/https/);
    expect(problemsOf({ ...prodBase, DATABASE_URL: undefined }).join()).toMatch(/DATABASE_URL/);
    expect(problemsOf({ ...prodBase, ENTRA_CLIENT_SECRET: undefined }).join()).toMatch(/ENTRA_CLIENT_SECRET/);
    expect(problemsOf({ ...prodBase, TOKEN_ENC_KEY: 'too-short' }).join()).toMatch(/TOKEN_ENC_KEY/);
  });

  it('reads secrets from *_FILE (Docker secrets)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sp-config-'));
    const file = path.join(dir, 'session_secret');
    writeFileSync(file, `${'s'.repeat(40)}\n`);
    const pw = path.join(dir, 'db_password');
    writeFileSync(pw, 'p@ss/word');
    const config = loadConfig({ ...prodBase, SESSION_SECRET: undefined, SESSION_SECRET_FILE: file, DATABASE_PASSWORD_FILE: pw });
    expect(config.auth.sessionSecret).toBe('s'.repeat(40));
    expect(config.db.kind === 'pg' && config.db.url).toContain(encodeURIComponent('p@ss/word'));
  });

  it('development defaults: dev login, mock, PGlite, Vite origin allowed', () => {
    const config = loadConfig({ NODE_ENV: 'development' });
    expect(config.auth.mode).toBe('dev');
    expect(config.integrationsMode).toBe('mock');
    expect(config.db.kind).toBe('pglite');
    expect(config.worker.embedded).toBe(true);
    expect(config.allowedOrigins).toContain('http://localhost:5173');
  });
});
