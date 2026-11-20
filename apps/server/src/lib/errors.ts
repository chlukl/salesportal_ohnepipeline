/**
 * Safe error responses (ARCHITECTURE §5.5): never leak internals or stack traces.
 * Throw `AppError` (or the helpers) from handlers/services; everything else becomes a generic 500.
 */
import type { ApiErrorBody } from '@sales-portal/shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import { safeErrorMessage } from './logger';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    /** German message safe to show to the user. */
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message = 'Ungültige Anfrage', code = 'bad_request') => new AppError(400, code, message);
export const unauthorized = (message = 'Bitte anmelden', code = 'unauthorized') => new AppError(401, code, message);
export const forbidden = (message = 'Keine Berechtigung', code = 'forbidden') => new AppError(403, code, message);
export const notFound = (message = 'Nicht gefunden', code = 'not_found') => new AppError(404, code, message);
export const conflict = (message = 'Konflikt', code = 'conflict') => new AppError(409, code, message);
export const unprocessable = (message: string, code = 'unprocessable') => new AppError(422, code, message);
export const tooManyRequests = (message = 'Zu viele Anfragen – bitte kurz warten', code = 'rate_limited') =>
  new AppError(429, code, message);
export const notImplemented = (message = 'Noch nicht umgesetzt', code = 'not_implemented') => new AppError(501, code, message);
export const upstreamError = (message = 'Externes System nicht erreichbar', code = 'upstream_error') =>
  new AppError(502, code, message);

function body(code: string, message: string, requestId: string, issues?: ApiErrorBody['error']['issues']): ApiErrorBody {
  return { error: { code, message, requestId, ...(issues ? { issues } : {}) } };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError | Error, request, reply) => {
    const requestId = request.id;

    if (err instanceof AppError) {
      if (err.statusCode >= 500) request.log.error({ err, code: err.code }, 'app error');
      return reply.status(err.statusCode).send(body(err.code, err.message, requestId));
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      const issues = err.validation.map((v) => ({
        path: `${v.instancePath || ((v.params as { issue?: { path?: unknown[] } } | undefined)?.issue?.path ?? []).join('.')}`.replace(/^\//, '').replace(/\//g, '.'),
        message: v.message ?? 'ungültig',
      }));
      return reply.status(400).send(body('validation_error', 'Eingaben sind ungültig', requestId, issues));
    }
    if (isResponseSerializationError(err)) {
      request.log.error({ err: { message: safeErrorMessage(err), method: err.method, url: err.url } }, 'response serialization failed');
      return reply.status(500).send(body('internal_error', 'Interner Fehler', requestId));
    }
    const fe = err as FastifyError;
    if (typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500) {
      // Fastify / plugin client errors (body too large, bad JSON, rate limit …) – message is generic and safe.
      const code = fe.statusCode === 429 ? 'rate_limited' : (fe.code ?? 'bad_request').toLowerCase();
      const message =
        fe.statusCode === 429
          ? 'Zu viele Anfragen – bitte kurz warten'
          : fe.statusCode === 413
            ? 'Anfrage zu gross'
            : fe.statusCode === 415
              ? 'Format nicht unterstützt'
              : 'Ungültige Anfrage';
      return reply.status(fe.statusCode).send(body(code, message, requestId));
    }
    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send(body('internal_error', 'Interner Fehler', requestId));
  });
}

/** Body for unknown routes (the not-found handler itself is set in app.ts because of the SPA fallback). */
export function notFoundBody(requestId: string): ApiErrorBody {
  return body('not_found', 'Nicht gefunden', requestId);
}
