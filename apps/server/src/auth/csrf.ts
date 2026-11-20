/**
 * CSRF (ARCHITECTURE §5.3): every non-GET request needs `X-CSRF-Token` (per session, constant-time compared)
 * AND a same-origin signal (`Origin` in the allow-list, or `Sec-Fetch-Site: same-origin`). No CORS at all.
 */
import type { FastifyRequest } from 'fastify';
import { forbidden } from '../lib/errors';
import { safeEqual } from './crypto';

export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/** true when the request demonstrably comes from our own origin. */
export function isSameOrigin(request: FastifyRequest, allowedOrigins: string[]): boolean {
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) return allowedOrigins.includes(origin);
  const site = request.headers['sec-fetch-site'];
  if (typeof site === 'string' && site.length > 0) return site === 'same-origin';
  return false;
}

export function assertSameOrigin(request: FastifyRequest, allowedOrigins: string[]): void {
  if (!isSameOrigin(request, allowedOrigins)) throw forbidden('Anfrage von fremder Herkunft abgelehnt', 'csrf_origin');
}

export function assertCsrfToken(request: FastifyRequest, expected: string): void {
  const header = request.headers[CSRF_HEADER];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided || !safeEqual(provided, expected)) throw forbidden('Sicherheitstoken fehlt oder ist ungültig', 'csrf_token');
}
