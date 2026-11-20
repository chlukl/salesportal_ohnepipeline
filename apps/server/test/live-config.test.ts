import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

const base = { NODE_ENV: 'development', LOG_LEVEL: 'silent' };
const live = {
  ...base,
  CRM_ADAPTER: 'live',
  DATAVERSE_URL: 'https://org.crm4.dynamics.com',
  ENTRA_TENANT_ID: '11111111-1111-1111-1111-111111111111',
  ENTRA_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
  ENTRA_CLIENT_SECRET: 'secret',
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

describe('config – live integrations', () => {
  it('mock mode needs no live settings', () => {
    expect(problemsOf(base)).toEqual([]);
  });

  it('live CRM without Entra app or Dataverse URL → clear startup errors (also outside production)', () => {
    const p = problemsOf({ ...base, CRM_ADAPTER: 'live' }).join('\n');
    expect(p).toMatch(/ENTRA_TENANT_ID fehlt \(CRM_ADAPTER=live\)/);
    expect(p).toMatch(/ENTRA_CLIENT_ID fehlt/);
    expect(p).toMatch(/ENTRA_CLIENT_SECRET oder ENTRA_CLIENT_CERT/);
    expect(p).toMatch(/DATAVERSE_URL fehlt/);
  });

  it('accepts a complete live CRM setup and validates the Dataverse URL', () => {
    expect(problemsOf(live)).toEqual([]);
    expect(problemsOf({ ...live, DATAVERSE_URL: 'http://org.crm4.dynamics.com' }).join()).toMatch(/https/);
    expect(problemsOf({ ...live, DATAVERSE_URL: 'https://org.crm4.dynamics.com/api/data/v9.2' }).join()).toMatch(/ohne Pfad/);
    expect(problemsOf({ ...live, DATAVERSE_CAMPAIGN_SENDER_IDS: 'not-a-guid' }).join()).toMatch(/GUID/);
  });

  it('certificate credential must be complete and valid PEM', () => {
    const noSecret = { ...live, ENTRA_CLIENT_SECRET: undefined };
    expect(problemsOf({ ...noSecret, ENTRA_CLIENT_CERT: '-----BEGIN CERTIFICATE-----\nxx\n-----END CERTIFICATE-----' }).join()).toMatch(/zusammen gesetzt/);
    expect(problemsOf({ ...noSecret, ENTRA_CLIENT_CERT: 'garbage', ENTRA_CLIENT_KEY: 'garbage' }).join()).toMatch(/kein gültiges PEM/);
  });

  it('Graph: allowed mailboxes must be valid; the background sender must be one of them', () => {
    const graph = { ...live, CRM_ADAPTER: 'mock', CALENDAR_ADAPTER: 'live', MAIL_ADAPTER: 'live' };
    expect(problemsOf({ ...graph, GRAPH_ALLOWED_MAILBOXES: 'manuel@kallysoft.ch, nico@kallysoft.ch' })).toEqual([]);
    expect(problemsOf({ ...graph, GRAPH_ALLOWED_MAILBOXES: 'manuel' }).join()).toMatch(/ungültige Adresse/);
    expect(problemsOf({ ...graph, GRAPH_ALLOWED_MAILBOXES: 'manuel@kallysoft.ch', GRAPH_APP_MAIL_SENDER: 'sales@kallysoft.ch' }).join()).toMatch(
      /GRAPH_APP_MAIL_SENDER/,
    );
    const config = loadConfig({ ...graph, GRAPH_ALLOWED_MAILBOXES: 'Manuel@Kallysoft.ch,manuel@kallysoft.ch' });
    expect(config.live.allowedMailboxes).toEqual(['manuel@kallysoft.ch']);
  });

  it('entra login + delegated refresh-token flow needs offline_access', () => {
    const entra = { ...live, AUTH_MODE: 'entra', TOKEN_ENC_KEY: Buffer.alloc(32, 1).toString('base64') };
    expect(problemsOf(entra)).toEqual([]);
    expect(problemsOf({ ...entra, ENTRA_SCOPES: 'openid profile email User.Read' }).join()).toMatch(/offline_access/);
    expect(problemsOf({ ...entra, ENTRA_SCOPES: 'openid api://x/access_as_user', ENTRA_DELEGATED_FLOW: 'obo' })).toEqual([]);
  });

  it('production outside Prod with live calendar needs MAIL_TEST_RECIPIENT (no Teams invitations to customers)', () => {
    const prod = {
      ...live,
      NODE_ENV: 'production',
      PUBLIC_URL: 'https://portal.intern.example',
      DATABASE_URL: 'postgres://sales_portal@db:5432/sales_portal',
      SESSION_SECRET: 'x'.repeat(48),
      TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
      AUTH_MODE: 'entra',
      INTEGRATIONS: 'mock',
      ALLOW_MOCK_IN_PRODUCTION: 'true',
      CALENDAR_ADAPTER: 'live',
      GRAPH_ALLOWED_MAILBOXES: 'manuel@kallysoft.ch',
    };
    expect(problemsOf({ ...prod, ENVIRONMENT_LABEL: 'Sandbox' }).join()).toMatch(/MAIL_TEST_RECIPIENT fehlt \(Termineinladungen/);
    expect(problemsOf({ ...prod, ENVIRONMENT_LABEL: 'Sandbox', MAIL_TEST_RECIPIENT: 'test@kallysoft.ch' })).toEqual([]);
    expect(problemsOf({ ...prod, ENVIRONMENT_LABEL: 'Prod' })).toEqual([]);
  });
});
