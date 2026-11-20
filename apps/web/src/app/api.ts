/**
 * API client. Same origin only (Vite proxies /api in dev). Sends `X-CSRF-Token` on every non-GET request;
 * a 401 anywhere triggers the global «go to login» handler.
 *
 *   const leads = await api.get<Paged<Lead>>('/api/leads', { grades: ['A', 'B'], pageSize: 50 });
 *   await api.post('/api/calls', { leadId });
 */
import type { ApiErrorBody } from '@sales-portal/shared';

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly issues: { path: string; message: string }[] = [],
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const UNAUTHORIZED_EVENT = 'sp:unauthorized';
export const CSRF_INVALID_EVENT = 'sp:csrf-invalid';

export type QueryValue = string | number | boolean | null | undefined | (string | number)[];

/** `{ grades: ['A','B'], page: 2 }` → `?grades=A,B&page=2` (empty values are dropped). */
export function toQuery(params?: Record<string, QueryValue>): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length) search.set(key, value.join(','));
    } else {
      search.set(key, String(value));
    }
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD' && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Keine Verbindung zum Server');
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;

  if (!res.ok) {
    const err = (data as ApiErrorBody | undefined)?.error;
    const apiError = new ApiError(res.status, err?.code ?? 'error', err?.message ?? 'Unerwarteter Fehler', err?.issues ?? [], err?.requestId);
    if (res.status === 401) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    if (res.status === 403 && apiError.code === 'csrf_token') window.dispatchEvent(new CustomEvent(CSRF_INVALID_EVENT));
    throw apiError;
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, params?: Record<string, QueryValue>, signal?: AbortSignal) => request<T>('GET', `${path}${toQuery(params)}`, undefined, signal),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/** German message for any error (for toasts). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Etwas ist schiefgelaufen – bitte nochmals versuchen';
}
