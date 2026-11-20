/**
 * Microsoft Graph client for the live calendar and mail adapters: requests, paging, JSON `$batch`, and the mailbox
 * guard (GRAPH_ALLOWED_MAILBOXES). Times are requested in UTC (`Prefer: outlook.timezone="UTC"`).
 */
import type { LiveConfig } from '../../config';
import type { Logger } from '../../lib/logger';
import type { AdapterAuth } from '../types';
import { MailboxNotAllowedError, upstreamError } from './errors';
import { upstreamCodeOf, type HttpClient, type HttpResponse, type RetryMode } from './http';

const MAILBOX_RE = /^[^\s@<>()",;/\\]+@[^\s@<>()",;/\\]+\.[^\s@<>()",;/\\]+$/;
export const UTC_PREFER = 'outlook.timezone="UTC"';

export interface GraphClientOptions {
  /** e.g. `https://graph.microsoft.com/v1.0` */
  baseUrl: string;
  http: HttpClient;
  getToken: () => Promise<string>;
  log?: Pick<Logger, 'warn' | 'debug'>;
}

export interface GraphRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path relative to the base URL (`/users/x/events`), or an absolute nextLink/deltaLink on the same host. */
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  retry?: RetryMode;
}

export class GraphError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
  ) {
    super(`graph ${status} ${code ?? ''}`);
  }
}

export class GraphClient {
  readonly base: string;
  readonly origin: string;

  constructor(private readonly opts: GraphClientOptions) {
    this.base = opts.baseUrl.replace(/\/$/, '');
    this.origin = new URL(this.base).origin;
  }

  /** Absolute URL; absolute inputs (next/delta links) must point to the Graph host (token never leaves Graph). */
  resolve(path: string): string {
    if (/^https:\/\//i.test(path)) {
      if (!path.startsWith(`${this.origin}/`)) throw new GraphError(400, 'foreign_link');
      return path;
    }
    if (!path.startsWith('/')) throw new GraphError(400, 'invalid_path');
    return `${this.base}${path}`;
  }

  async raw(req: GraphRequest): Promise<HttpResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.opts.getToken()}`,
      Accept: 'application/json',
      ...req.headers,
    };
    if (req.body !== undefined) headers['Content-Type'] = 'application/json';
    return this.opts.http.send({
      service: 'graph',
      method: req.method,
      url: this.resolve(req.path),
      headers,
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      retry: req.retry,
    });
  }

  /** Request expecting 2xx; throws GraphError otherwise (callers map to AppError via `toAppError`). */
  async request<T = unknown>(req: GraphRequest): Promise<T> {
    const res = await this.raw(req);
    if (res.status < 200 || res.status >= 300) {
      const code = upstreamCodeOf(res);
      this.opts.log?.warn({ status: res.status, error: code, method: req.method }, 'graph request failed');
      throw new GraphError(res.status, code);
    }
    return (res.status === 204 || !res.text ? undefined : res.json<T>()) as T;
  }

  /** GET all pages of a collection (follows @odata.nextLink on the Graph host). */
  async list<T>(path: string, headers: Record<string, string> = {}, maxItems = 2000): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = path;
    let pages = 0;
    while (next && out.length < maxItems && pages < 200) {
      const page: { value?: T[]; '@odata.nextLink'?: string } = await this.request({ method: 'GET', path: next, headers });
      out.push(...(page.value ?? []));
      next = page['@odata.nextLink'] ?? null;
      pages++;
    }
    return out.slice(0, maxItems);
  }

  /**
   * JSON `$batch` (max 20 requests per call). Throttled sub-requests (429) are retried up to 3 rounds,
   * honouring the largest Retry-After. Returns responses in request order.
   */
  async batch(
    requests: { id: string; method: 'GET'; url: string; headers?: Record<string, string> }[],
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ): Promise<Map<string, { status: number; body: unknown }>> {
    const results = new Map<string, { status: number; body: unknown }>();
    for (let i = 0; i < requests.length; i += 20) {
      let pending = requests.slice(i, i + 20);
      for (let round = 0; pending.length && round < 4; round++) {
        const res = await this.request<{ responses: { id: string; status: number; body?: unknown; headers?: Record<string, string> }[] }>({
          method: 'POST',
          path: '/$batch',
          body: { requests: pending },
          retry: 'idempotent', // only GET sub-requests
        });
        const throttled: typeof pending = [];
        let wait = 0;
        for (const r of res.responses ?? []) {
          if (r.status === 429 && round < 3) {
            const req = pending.find((p) => p.id === r.id);
            if (req) throttled.push(req);
            const ra = Number(r.headers?.['Retry-After'] ?? r.headers?.['retry-after'] ?? 1);
            wait = Math.max(wait, Number.isFinite(ra) ? ra * 1000 : 1000);
          } else {
            results.set(r.id, { status: r.status, body: r.body });
          }
        }
        pending = throttled;
        if (pending.length) await sleep(Math.min(wait, 30_000));
      }
    }
    return results;
  }
}

/** Map a Graph failure to a safe AppError. */
export function toAppError(err: unknown): unknown {
  if (err instanceof GraphError) return upstreamError('graph', err.status === 400 && err.code === 'foreign_link' ? 502 : err.status, err.code);
  return err;
}

/** Validated, lower-case mailbox address. */
export function normalizeMailbox(mailbox: string): string {
  const m = mailbox.trim().toLowerCase();
  if (!MAILBOX_RE.test(m) || m.length > 254) throw new MailboxNotAllowedError('Ungültige Postfach-Adresse');
  return m;
}

/**
 * Mailbox guard + Graph path:
 * - only mailboxes in GRAPH_ALLOWED_MAILBOXES (when the list is set),
 * - app-only access requires the list (secure default – RBAC for Applications should mirror it),
 * - delegated access to the user's own mailbox uses `/me`, others `/users/{mailbox}` (delegate access).
 */
export function mailboxPath(live: Pick<LiveConfig, 'allowedMailboxes'>, auth: AdapterAuth, mailbox: string): string {
  const m = normalizeMailbox(mailbox);
  const allowed = live.allowedMailboxes;
  if (auth.kind === 'system' && allowed.length === 0) {
    throw new MailboxNotAllowedError('App-Zugriff auf Postfächer ist nicht freigegeben (GRAPH_ALLOWED_MAILBOXES fehlt)');
  }
  if (allowed.length > 0 && !allowed.includes(m)) throw new MailboxNotAllowedError();
  if (auth.kind === 'user' && auth.email.trim().toLowerCase() === m) return '/me';
  return `/users/${encodeURIComponent(m)}`;
}

export function isMailboxAllowed(live: Pick<LiveConfig, 'allowedMailboxes'>, auth: AdapterAuth, mailbox: string): boolean {
  try {
    mailboxPath(live, auth, mailbox);
    return true;
  } catch {
    return false;
  }
}
