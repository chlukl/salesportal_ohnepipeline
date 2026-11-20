/**
 * Environment configuration (ARCHITECTURE §5.1, §5.9).
 *
 * - Every secret can be passed as `<NAME>` or `<NAME>_FILE` (Docker secrets). `_FILE` wins.
 * - zod-validated; refuses insecure production configurations with a clear error.
 */
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { z } from 'zod';

const SECRET_NAMES = [
  'SESSION_SECRET',
  'TOKEN_ENC_KEY',
  'ENTRA_CLIENT_SECRET',
  'ANTHROPIC_API_KEY',
  'DATABASE_PASSWORD',
  'DATABASE_URL',
  'VERA_API_KEY',
  // Live integrations: certificate credential of the portal app registration (PEM). Prefer `_FILE` (Docker secret).
  'ENTRA_CLIENT_CERT',
  'ENTRA_CLIENT_KEY',
] as const;

const DEV_SESSION_SECRET = 'dev-only-session-secret-not-for-production-0000';

const boolString = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));

const adapterMode = z.enum(['mock', 'live']);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Public base URL of the portal as seen by the browser (redirect URIs, origin check). */
  PUBLIC_URL: z.string().url().optional(),
  /** Additional allowed origins for the CSRF origin check (comma-separated). */
  ALLOWED_ORIGINS: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().optional(),
  DATABASE_PASSWORD: z.string().optional(),
  DATABASE_SSL: boolString.default(false),
  /** PGlite data dir when DATABASE_URL is unset; `memory://` for tests. */
  PGLITE_DIR: z.string().default('./data/pglite'),
  ALLOW_PGLITE_IN_PRODUCTION: boolString.default(false),

  AUTH_MODE: z.enum(['dev', 'entra']).default('dev'),
  SESSION_SECRET: z.string().optional(),
  SESSION_IDLE_HOURS: z.coerce.number().positive().default(12),
  SESSION_ABSOLUTE_DAYS: z.coerce.number().positive().default(7),
  /** 32-byte key (base64 or hex) for AES-256-GCM token encryption. */
  TOKEN_ENC_KEY: z.string().optional(),
  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  ENTRA_SCOPES: z.string().default('openid profile email offline_access User.Read'),
  /** Comma-separated emails that get the admin role on first Entra login. */
  BOOTSTRAP_ADMIN_EMAILS: z.string().default(''),

  INTEGRATIONS: adapterMode.default('mock'),
  CRM_ADAPTER: adapterMode.optional(),
  CALENDAR_ADAPTER: adapterMode.optional(),
  MAIL_ADAPTER: adapterMode.optional(),
  AI_ADAPTER: adapterMode.optional(),
  TRANSCRIPT_ADAPTER: adapterMode.optional(),
  TELEPHONY_ADAPTER: adapterMode.optional(),
  ALLOW_MOCK_IN_PRODUCTION: boolString.default(false),
  ENVIRONMENT_LABEL: z.enum(['Demo', 'Sandbox', 'Prod']).default('Demo'),
  /** Seed demo data (users, ~400 leads …) when the CRM adapter is mock. */
  SEED_DEMO_DATA: boolString.default(true),

  DATAVERSE_URL: z.string().url().optional(),
  GRAPH_BASE_URL: z.string().url().default('https://graph.microsoft.com/v1.0'),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL_ANALYSIS: z.string().default('claude-opus-5-5'),
  AI_MODEL_MAIL: z.string().default('claude-sonnet-5-5'),
  VERA_API_URL: z.string().url().optional(),
  VERA_API_KEY: z.string().optional(),
  /** All customer mails go here in mock/sandbox mode. */
  MAIL_TEST_RECIPIENT: z.string().email().optional(),

  /** Run the job runner inside the API process (forced with PGlite, which is single-process). */
  WORKER_EMBEDDED: boolString.default(false),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(2000),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),

  /** Directory of the built web app (served in production). */
  WEB_DIST_DIR: z.string().optional(),
  /** Comma-separated feature flags, e.g. `callbackDetection,weeklyReport`. */
  FEATURE_FLAGS: z.string().default(''),
  /**
   * Reverse proxy in front of the app (X-Forwarded-For → request.ip, used for rate limits of anonymous requests):
   * `false` (default) or the proxy's address(es) as the app sees them (IP/CIDR, comma-separated).
   * Never «trust every hop» (`true`): the client could then pick its own IP and bypass the rate limits.
   */
  TRUST_PROXY: z.string().default('false'),

  // --- Live integrations (Dataverse / Graph), see README «Live-Anbindung» -----------------------------------------
  /** Public certificate (PEM) + private key (PEM) of the app registration; alternative to ENTRA_CLIENT_SECRET. */
  ENTRA_CLIENT_CERT: z.string().optional(),
  ENTRA_CLIENT_KEY: z.string().optional(),
  ENTRA_AUTHORITY_HOST: z
    .string()
    .regex(/^[a-z0-9.-]+$/i)
    .default('login.microsoftonline.com'),
  /** Delegated token flow for user actions: `auto` = OBO if the session token is issued for the portal API, else refresh token. */
  ENTRA_DELEGATED_FLOW: z.enum(['auto', 'obo', 'refresh_token']).default('auto'),
  /** Mailboxes the portal may touch via Graph (calendar + mail), comma-separated. App-only access needs this list. */
  GRAPH_ALLOWED_MAILBOXES: z.string().default(''),
  /** Sender mailbox for background mails (briefing, weekly report) – must be in GRAPH_ALLOWED_MAILBOXES. */
  GRAPH_APP_MAIL_SENDER: z.string().email().optional(),
  GRAPH_DELTA_PAST_DAYS: z.coerce.number().int().min(0).max(60).default(7),
  GRAPH_DELTA_FUTURE_DAYS: z.coerce.number().int().min(7).max(400).default(180),
  /** systemuser ids whose e-mail activities are automated campaign mails (Lemlist flow), comma-separated GUIDs. */
  DATAVERSE_CAMPAIGN_SENDER_IDS: z.string().default(''),
  /** Entity set of the booking table (FixCRMSolution). */
  DATAVERSE_BOOKING_ENTITY_SET: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/)
    .default('kls_buchungs'),
  LIVE_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
});

export type RawEnv = z.input<typeof EnvSchema>;

export type AdapterName = 'crm' | 'calendar' | 'mail' | 'ai' | 'transcripts' | 'telephony';

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  isProd: boolean;
  host: string;
  port: number;
  publicUrl: string;
  allowedOrigins: string[];
  logLevel: string;
  db: { kind: 'pg'; url: string; ssl: boolean } | { kind: 'pglite'; dataDir: string };
  auth: {
    mode: 'dev' | 'entra';
    sessionSecret: string;
    idleTimeoutMs: number;
    absoluteTimeoutMs: number;
    tokenEncKey: Buffer | null;
    entra: {
      tenantId: string;
      clientId: string;
      clientSecret: string;
      scopes: string[];
      redirectUri: string;
      postLogoutRedirectUri: string;
    } | null;
    bootstrapAdminEmails: string[];
  };
  adapters: Record<AdapterName, 'mock' | 'live'>;
  integrationsMode: 'mock' | 'live' | 'mixed';
  environmentLabel: 'Demo' | 'Sandbox' | 'Prod';
  seedDemoData: boolean;
  dataverseUrl: string | null;
  graphBaseUrl: string;
  ai: { apiKey: string | null; modelAnalysis: string; modelMail: string };
  vera: { url: string | null; apiKey: string | null };
  mailTestRecipient: string | null;
  worker: { embedded: boolean; pollMs: number; concurrency: number };
  webDistDir: string | null;
  features: Record<string, boolean>;
  /** Fastify `trustProxy`: false or the proxy addresses (never `true` = every hop). */
  trustProxy: false | string;
  /** Live integration settings (only validated when an adapter is `live`). */
  live: LiveConfig;
}

export interface LiveConfig {
  tenantId: string;
  clientId: string;
  /** Client credential of the app registration: secret or certificate (PEM). Never logged. */
  clientSecret: string | null;
  clientCertificate: { certPem: string; keyPem: string } | null;
  authorityHost: string;
  delegatedFlow: 'auto' | 'obo' | 'refresh_token';
  /** Lower-case mailbox addresses. */
  allowedMailboxes: string[];
  appMailSender: string | null;
  deltaPastDays: number;
  deltaFutureDays: number;
  campaignSenderIds: string[];
  bookingEntitySet: string;
  httpTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Unsichere oder ungültige Konfiguration:\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
  }
}

/** Resolve `<NAME>_FILE` secrets into plain values. */
function resolveSecretFiles(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = { ...env };
  for (const name of SECRET_NAMES) {
    const file = env[`${name}_FILE`];
    if (file) {
      try {
        out[name] = readFileSync(file, 'utf8').trim();
      } catch {
        throw new ConfigError([`${name}_FILE kann nicht gelesen werden (${file})`]);
      }
    }
  }
  return out;
}

/** Parse a 32-byte key given as base64 or hex. */
export function parseKey32(value: string): Buffer | null {
  const v = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  try {
    const b = Buffer.from(v, 'base64');
    if (b.length === 32) return b;
  } catch {
    /* fallthrough */
  }
  return null;
}

/** 127.0.0.0/8, ::1, localhost. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** URL whose host is loopback or `*.localhost`. */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return isLoopbackHost(host) || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

const PROXY_ADDR_NAMES = ['loopback', 'linklocal', 'uniquelocal'];

/**
 * TRUST_PROXY → Fastify `trustProxy`: `false` or the address(es) of the reverse proxy (IP / CIDR, comma-separated;
 * proxy-addr names `loopback`, `linklocal`, `uniquelocal` allowed). request.ip is then the right-most X-Forwarded-For
 * entry that is not a trusted proxy – entries the client puts in front do not count.
 * `true` («trust every hop», client picks its own IP) and hop counts (Fastify 5.12 ignores them, fail-closed) are
 * refused. Returns null for an invalid value.
 */
export function parseTrustProxy(value: string): false | string | null {
  const v = value.trim().toLowerCase();
  if (['', 'false', '0', 'no', 'off'].includes(v)) return false;
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  const ok = parts.every((p) => {
    if (PROXY_ADDR_NAMES.includes(p)) return true;
    const [addr, bits, ...rest] = p.split('/');
    if (rest.length || !isIP(addr)) return false;
    if (bits === undefined) return true;
    const n = Number(bits);
    return /^\d+$/.test(bits) && n >= 0 && n <= (isIP(addr) === 6 ? 128 : 32);
  });
  return parts.length && ok ? parts.join(',') : null;
}

function withPassword(url: string, password: string | undefined): string {
  if (!password) return url;
  const u = new URL(url);
  u.password = encodeURIComponent(password);
  return u.toString();
}

export function loadConfig(envInput: Record<string, string | undefined> = process.env): AppConfig {
  const env = resolveSecretFiles(envInput);
  // Treat empty strings as unset (docker-compose often passes `VAR=`).
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === 'production';
  const problems: string[] = [];

  const adapters: Record<AdapterName, 'mock' | 'live'> = {
    crm: e.CRM_ADAPTER ?? e.INTEGRATIONS,
    calendar: e.CALENDAR_ADAPTER ?? e.INTEGRATIONS,
    mail: e.MAIL_ADAPTER ?? e.INTEGRATIONS,
    ai: e.AI_ADAPTER ?? e.INTEGRATIONS,
    transcripts: e.TRANSCRIPT_ADAPTER ?? e.INTEGRATIONS,
    telephony: e.TELEPHONY_ADAPTER ?? e.INTEGRATIONS,
  };
  const modes = new Set(Object.values(adapters));
  const integrationsMode = modes.size === 1 ? [...modes][0] : 'mixed';
  const anyMock = modes.has('mock');

  // --- Session secret -------------------------------------------------------------------------------------------
  let sessionSecret = e.SESSION_SECRET;
  if (!sessionSecret) {
    if (isProd) problems.push('SESSION_SECRET fehlt (mind. 32 Bytes)');
    sessionSecret = DEV_SESSION_SECRET;
  }
  if (Buffer.byteLength(sessionSecret, 'utf8') < 32) problems.push('SESSION_SECRET ist kürzer als 32 Bytes');
  if (isProd && sessionSecret === DEV_SESSION_SECRET) problems.push('SESSION_SECRET ist der Entwicklungs-Standardwert');

  // --- Production refusals (ARCHITECTURE §5.1) -------------------------------------------------------------------
  if (isProd && e.AUTH_MODE === 'dev') problems.push('AUTH_MODE=dev ist in Produktion nicht erlaubt');
  if (isProd && anyMock && !e.ALLOW_MOCK_IN_PRODUCTION) {
    problems.push('Mock-Integrationen in Produktion nur mit ALLOW_MOCK_IN_PRODUCTION=true');
  }
  if (isProd && !e.DATABASE_URL && !e.ALLOW_PGLITE_IN_PRODUCTION) {
    problems.push('DATABASE_URL fehlt (PGlite ist in Produktion nur mit ALLOW_PGLITE_IN_PRODUCTION=true erlaubt)');
  }

  const publicUrl = (e.PUBLIC_URL ?? (isProd ? '' : 'http://localhost:5173')).replace(/\/$/, '');
  if (isProd && !publicUrl) problems.push('PUBLIC_URL fehlt');

  // --- Dev login (no credential) only on this machine, whatever NODE_ENV says --------------------------------------------
  // With AUTH_MODE=dev anyone who reaches the port can pick any user (incl. admin) – and with live adapters every user
  // action runs with the app registration. So the server must only listen on loopback and be opened via localhost.
  if (e.AUTH_MODE === 'dev') {
    if (!isLoopbackHost(e.HOST)) {
      problems.push(`AUTH_MODE=dev nur mit HOST=127.0.0.1/localhost/::1 (Dev-Login ohne Passwort darf nicht im Netz erreichbar sein, HOST=${e.HOST})`);
    }
    if (publicUrl && !isLocalUrl(publicUrl)) {
      problems.push('AUTH_MODE=dev nur mit PUBLIC_URL auf localhost (Dev-Login ohne Passwort darf nicht im Netz erreichbar sein)');
    }
  }

  const trustProxy = parseTrustProxy(e.TRUST_PROXY);
  if (trustProxy === null) {
    problems.push(
      'TRUST_PROXY: false oder die Adresse(n) des Reverse Proxy (IP/CIDR, Komma-getrennt, z. B. 172.18.0.1) – «true» (allen vertrauen) und Stufenzahlen sind nicht erlaubt',
    );
  }
  if (isProd && publicUrl && !publicUrl.startsWith('https://')) problems.push('PUBLIC_URL muss in Produktion https:// sein');

  // --- Token encryption + Entra ---------------------------------------------------------------------------------
  let tokenEncKey: Buffer | null = null;
  if (e.TOKEN_ENC_KEY) {
    tokenEncKey = parseKey32(e.TOKEN_ENC_KEY);
    if (!tokenEncKey) problems.push('TOKEN_ENC_KEY muss 32 Bytes sein (base64 oder 64 Hex-Zeichen)');
  }
  let entra: AppConfig['auth']['entra'] = null;
  if (e.AUTH_MODE === 'entra') {
    if (!e.ENTRA_TENANT_ID) problems.push('ENTRA_TENANT_ID fehlt');
    if (!e.ENTRA_CLIENT_ID) problems.push('ENTRA_CLIENT_ID fehlt');
    if (!e.ENTRA_CLIENT_SECRET) problems.push('ENTRA_CLIENT_SECRET fehlt');
    if (!e.TOKEN_ENC_KEY) problems.push('TOKEN_ENC_KEY fehlt (nötig für die verschlüsselte Token-Ablage)');
    if (!publicUrl) problems.push('PUBLIC_URL fehlt (Redirect-URI)');
    entra = {
      tenantId: e.ENTRA_TENANT_ID ?? '',
      clientId: e.ENTRA_CLIENT_ID ?? '',
      clientSecret: e.ENTRA_CLIENT_SECRET ?? '',
      scopes: e.ENTRA_SCOPES.split(/\s+/).filter(Boolean),
      redirectUri: `${publicUrl}/api/auth/callback`,
      postLogoutRedirectUri: `${publicUrl}/login`,
    };
  }
  if (isProd && adapters.ai === 'live' && !e.ANTHROPIC_API_KEY) problems.push('ANTHROPIC_API_KEY fehlt (AI_ADAPTER=live)');
  if (isProd && adapters.crm === 'live' && !e.DATAVERSE_URL) problems.push('DATAVERSE_URL fehlt (CRM_ADAPTER=live)');
  if (isProd && adapters.mail === 'live' && e.ENVIRONMENT_LABEL !== 'Prod' && !e.MAIL_TEST_RECIPIENT) {
    problems.push('MAIL_TEST_RECIPIENT fehlt (Mails ausserhalb Prod nur an Testadresse)');
  }
  if (isProd && adapters.calendar === 'live' && e.ENVIRONMENT_LABEL !== 'Prod' && !e.MAIL_TEST_RECIPIENT) {
    problems.push('MAIL_TEST_RECIPIENT fehlt (Termineinladungen an Kunden ausserhalb Prod nur an Testadresse, CALENDAR_ADAPTER=live)');
  }

  // --- Live integrations (Dataverse / Graph): checked only for adapters set to live ---------------------------------
  const live = buildLiveConfig(e, adapters, problems);

  if (problems.length) throw new ConfigError(problems);

  const allowedOrigins = new Set<string>();
  if (publicUrl) allowedOrigins.add(new URL(publicUrl).origin);
  if (!isProd) {
    // Dev: Vite (5173) proxies /api to the server; the server may also be opened directly.
    allowedOrigins.add(`http://localhost:${e.PORT}`);
    allowedOrigins.add(`http://127.0.0.1:${e.PORT}`);
    allowedOrigins.add('http://localhost:5173');
    allowedOrigins.add('http://127.0.0.1:5173');
  }
  for (const o of (e.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) allowedOrigins.add(new URL(o).origin);

  const features: Record<string, boolean> = { callbackDetection: false, weeklyReport: false, rescoring: false };
  for (const f of e.FEATURE_FLAGS.split(',').map((s) => s.trim()).filter(Boolean)) features[f] = true;

  const pglite = !e.DATABASE_URL;
  return {
    nodeEnv: e.NODE_ENV,
    isProd,
    host: e.HOST,
    port: e.PORT,
    publicUrl,
    allowedOrigins: [...allowedOrigins],
    logLevel: e.LOG_LEVEL,
    db: e.DATABASE_URL
      ? { kind: 'pg', url: withPassword(e.DATABASE_URL, e.DATABASE_PASSWORD), ssl: e.DATABASE_SSL }
      : { kind: 'pglite', dataDir: e.PGLITE_DIR },
    auth: {
      mode: e.AUTH_MODE,
      sessionSecret,
      idleTimeoutMs: e.SESSION_IDLE_HOURS * 3_600_000,
      absoluteTimeoutMs: e.SESSION_ABSOLUTE_DAYS * 86_400_000,
      tokenEncKey,
      entra,
      bootstrapAdminEmails: e.BOOTSTRAP_ADMIN_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    },
    adapters,
    integrationsMode,
    environmentLabel: e.ENVIRONMENT_LABEL,
    seedDemoData: e.SEED_DEMO_DATA && adapters.crm === 'mock',
    dataverseUrl: e.DATAVERSE_URL ?? null,
    graphBaseUrl: e.GRAPH_BASE_URL,
    ai: { apiKey: e.ANTHROPIC_API_KEY ?? null, modelAnalysis: e.AI_MODEL_ANALYSIS, modelMail: e.AI_MODEL_MAIL },
    vera: { url: e.VERA_API_URL ?? null, apiKey: e.VERA_API_KEY ?? null },
    mailTestRecipient: e.MAIL_TEST_RECIPIENT ?? null,
    worker: { embedded: e.WORKER_EMBEDDED || pglite, pollMs: e.WORKER_POLL_MS, concurrency: e.WORKER_CONCURRENCY },
    webDistDir: e.WEB_DIST_DIR ?? null,
    features,
    trustProxy: trustProxy ?? false,
    live,
  };
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAILBOX_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

/** Live settings + clear startup errors when a live adapter misses something (only for adapters set to live). */
function buildLiveConfig(
  e: z.output<typeof EnvSchema>,
  adapters: Record<AdapterName, 'mock' | 'live'>,
  problems: string[],
): LiveConfig {
  const crmLive = adapters.crm === 'live';
  const graphLive = adapters.calendar === 'live' || adapters.mail === 'live';
  const anyMsLive = crmLive || graphLive;

  const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);
  const allowedMailboxes = list(e.GRAPH_ALLOWED_MAILBOXES).map((m) => m.toLowerCase());
  const campaignSenderIds = list(e.DATAVERSE_CAMPAIGN_SENDER_IDS).map((g) => g.toLowerCase());

  let clientCertificate: LiveConfig['clientCertificate'] = null;
  if (e.ENTRA_CLIENT_CERT || e.ENTRA_CLIENT_KEY) {
    if (!e.ENTRA_CLIENT_CERT || !e.ENTRA_CLIENT_KEY) {
      if (anyMsLive) problems.push('ENTRA_CLIENT_CERT und ENTRA_CLIENT_KEY müssen zusammen gesetzt sein (Zertifikat + privater Schlüssel)');
    } else {
      try {
        new X509Certificate(e.ENTRA_CLIENT_CERT);
        createPrivateKey(e.ENTRA_CLIENT_KEY);
        clientCertificate = { certPem: e.ENTRA_CLIENT_CERT, keyPem: e.ENTRA_CLIENT_KEY };
      } catch {
        if (anyMsLive) problems.push('ENTRA_CLIENT_CERT / ENTRA_CLIENT_KEY sind kein gültiges PEM-Zertifikat bzw. kein privater Schlüssel');
      }
    }
  }

  if (anyMsLive) {
    const which = [crmLive ? 'CRM_ADAPTER' : null, adapters.calendar === 'live' ? 'CALENDAR_ADAPTER' : null, adapters.mail === 'live' ? 'MAIL_ADAPTER' : null]
      .filter(Boolean)
      .join('/');
    if (!e.ENTRA_TENANT_ID) problems.push(`ENTRA_TENANT_ID fehlt (${which}=live)`);
    if (!e.ENTRA_CLIENT_ID) problems.push(`ENTRA_CLIENT_ID fehlt (${which}=live)`);
    if (!e.ENTRA_CLIENT_SECRET && !clientCertificate && !(e.ENTRA_CLIENT_CERT || e.ENTRA_CLIENT_KEY)) {
      problems.push(`ENTRA_CLIENT_SECRET oder ENTRA_CLIENT_CERT/ENTRA_CLIENT_KEY fehlt (${which}=live, App-Zugang für Hintergrundjobs)`);
    }
    if (
      e.AUTH_MODE === 'entra' &&
      e.ENTRA_DELEGATED_FLOW !== 'obo' &&
      !e.ENTRA_SCOPES.split(/\s+/).includes('offline_access')
    ) {
      problems.push('ENTRA_SCOPES braucht offline_access (Refresh-Token für delegierte CRM-/Graph-Zugriffe)');
    }
  }
  if (crmLive) {
    if (!e.DATAVERSE_URL) {
      // (production already reports this above)
      if (e.NODE_ENV !== 'production') problems.push('DATAVERSE_URL fehlt (CRM_ADAPTER=live)');
    } else {
      const u = new URL(e.DATAVERSE_URL);
      if (u.protocol !== 'https:') problems.push('DATAVERSE_URL muss https:// sein');
      if (u.pathname !== '/' || u.search) problems.push('DATAVERSE_URL ohne Pfad angeben, z. B. https://<org>.crm4.dynamics.com');
    }
    for (const id of campaignSenderIds) if (!GUID_RE.test(id)) problems.push('DATAVERSE_CAMPAIGN_SENDER_IDS enthält eine ungültige GUID');
  }
  if (graphLive) {
    if (!e.GRAPH_BASE_URL.startsWith('https://')) problems.push('GRAPH_BASE_URL muss https:// sein');
    for (const m of allowedMailboxes) if (!MAILBOX_RE.test(m)) problems.push('GRAPH_ALLOWED_MAILBOXES enthält eine ungültige Adresse');
    const sender = e.GRAPH_APP_MAIL_SENDER?.toLowerCase();
    if (sender && !allowedMailboxes.includes(sender)) problems.push('GRAPH_APP_MAIL_SENDER muss in GRAPH_ALLOWED_MAILBOXES stehen');
  }

  return {
    tenantId: e.ENTRA_TENANT_ID ?? '',
    clientId: e.ENTRA_CLIENT_ID ?? '',
    clientSecret: e.ENTRA_CLIENT_SECRET ?? null,
    clientCertificate,
    authorityHost: e.ENTRA_AUTHORITY_HOST,
    delegatedFlow: e.ENTRA_DELEGATED_FLOW,
    allowedMailboxes: [...new Set(allowedMailboxes)],
    appMailSender: e.GRAPH_APP_MAIL_SENDER?.toLowerCase() ?? null,
    deltaPastDays: e.GRAPH_DELTA_PAST_DAYS,
    deltaFutureDays: e.GRAPH_DELTA_FUTURE_DAYS,
    campaignSenderIds: [...new Set(campaignSenderIds)],
    bookingEntitySet: e.DATAVERSE_BOOKING_ENTITY_SET,
    httpTimeoutMs: e.LIVE_HTTP_TIMEOUT_MS,
  };
}
