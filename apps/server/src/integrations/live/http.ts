/**
 * Small HTTP client for Dataverse, Graph and Entra: timeouts, retries with exponential backoff on 429/503/504
 * (honouring `Retry-After`), and logging WITHOUT query strings, bodies or headers (no tokens, no personal data).
 */
import type { Logger } from '../../lib/logger';
import { upstreamError, type LiveService } from './errors';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * - `idempotent`: retry on 429/502/503/504 and network errors/timeouts (GET, PATCH with If-Match, DELETE, PUT,
 *   POST with an idempotency key such as Graph `transactionId`).
 * - `throttle_only`: retry only on 429 (request was rejected before processing) – non-idempotent POSTs like sendMail.
 * - `none`: never retry.
 */
export type RetryMode = 'idempotent' | 'throttle_only' | 'none';

export interface HttpRequest {
  service: LiveService;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  retry?: RetryMode;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  /** Raw body text ('' for 204). */
  text: string;
  json<T = unknown>(): T;
}

export interface HttpClientOptions {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  log?: Pick<Logger, 'debug' | 'warn'>;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  /** For Retry-After given as HTTP date. */
  now?: () => number;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Parse `Retry-After` (seconds or HTTP date) → milliseconds, or null. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const date = Date.parse(v);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return null;
}

/** Path of a URL without query string (for logs). */
export function safePath(url: string): string {
  try {
    const u = new URL(url);
    // Mask GUIDs and e-mail addresses (mailbox paths) – logs must not contain personal data.
    return `${u.host}${u.pathname}`
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
      .replace(/[^/]+(@|%40)[^/]+/g, ':mailbox');
  } catch {
    return '(invalid url)';
  }
}

export class HttpClient {
  private readonly fetchFn: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: HttpClientOptions = {}) {
    this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = options.maxRetries ?? 4;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  private shouldRetry(mode: RetryMode, status: number): boolean {
    if (mode === 'none') return false;
    if (status === 429) return true;
    return mode === 'idempotent' && (status === 502 || status === 503 || status === 504);
  }

  private backoff(attempt: number, retryAfterMs: number | null): number {
    if (retryAfterMs != null) return Math.min(retryAfterMs, this.maxDelayMs);
    const exp = this.baseDelayMs * 2 ** attempt;
    return Math.min(exp + Math.floor(this.random() * this.baseDelayMs), this.maxDelayMs);
  }

  /** Send a request; returns the final response (any status). Throws only for network errors/timeouts after retries. */
  async send(req: HttpRequest): Promise<HttpResponse> {
    const mode = req.retry ?? (req.method === 'GET' || req.method === 'DELETE' || req.method === 'PUT' ? 'idempotent' : 'throttle_only');
    const path = safePath(req.url);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          signal: AbortSignal.timeout(req.timeoutMs ?? this.timeoutMs),
          redirect: 'manual',
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : 'Error';
        if (mode === 'idempotent' && attempt < this.maxRetries) {
          const delay = this.backoff(attempt, null);
          this.options.log?.warn({ service: req.service, method: req.method, path, attempt, error: name, delayMs: delay }, 'live http: network error, retrying');
          await this.sleep(delay);
          continue;
        }
        this.options.log?.warn({ service: req.service, method: req.method, path, attempt, error: name }, 'live http: network error');
        throw upstreamError(req.service, 0, name === 'TimeoutError' ? 'timeout' : 'network');
      }
      const text = res.status === 204 ? '' : await res.text();
      if (this.shouldRetry(mode, res.status) && attempt < this.maxRetries) {
        const delay = this.backoff(attempt, parseRetryAfter(res.headers.get('retry-after'), this.now()));
        this.options.log?.warn({ service: req.service, method: req.method, path, status: res.status, attempt, delayMs: delay }, 'live http: throttled/unavailable, retrying');
        await this.sleep(delay);
        continue;
      }
      this.options.log?.debug({ service: req.service, method: req.method, path, status: res.status, attempt }, 'live http');
      return {
        status: res.status,
        headers: res.headers,
        text,
        json<T>() {
          return (text ? JSON.parse(text) : {}) as T;
        },
      };
    }
  }
}

/** Extract an upstream error code (`error.code` of Dataverse/Graph, `error` of Entra) – for logs only. */
export function upstreamCodeOf(res: HttpResponse): string | null {
  try {
    const body = res.json<{ error?: string | { code?: string } }>();
    if (typeof body.error === 'string') return body.error.slice(0, 80);
    if (body.error && typeof body.error.code === 'string') return body.error.code.slice(0, 80);
  } catch {
    /* not JSON */
  }
  return null;
}
