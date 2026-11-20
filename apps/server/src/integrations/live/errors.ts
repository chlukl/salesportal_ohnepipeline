/**
 * Typed errors of the live integrations. All extend `AppError`, so route handlers return a safe German message
 * (never upstream details, never tokens). Upstream error codes go to the log only.
 */
import { AppError } from '../../lib/errors';

export type LiveService = 'dataverse' | 'graph' | 'entra';

/** The Entra session of the user cannot provide a delegated token any more (expired / revoked / consent missing). */
export class ReauthRequiredError extends AppError {
  constructor(message = 'Bitte neu anmelden – der Zugang zu Microsoft 365 ist abgelaufen') {
    super(401, 'reauth_required', message);
    this.name = 'ReauthRequiredError';
  }
}

/** Optimistic concurrency: the record changed in the CRM since it was read (HTTP 412 on If-Match). */
export class ConcurrencyConflictError extends AppError {
  constructor(
    public readonly entity: string,
    public readonly entityId: string,
    message = 'Der Datensatz wurde inzwischen im CRM geändert – bitte Vorschau neu laden',
  ) {
    super(409, 'crm_concurrency_conflict', message, { entity, entityId });
    this.name = 'ConcurrencyConflictError';
  }
}

/** Mailbox is not in GRAPH_ALLOWED_MAILBOXES (or app-only access without an allow list). */
export class MailboxNotAllowedError extends AppError {
  constructor(message = 'Dieses Postfach ist für das Portal nicht freigegeben') {
    super(403, 'mailbox_not_allowed', message);
    this.name = 'MailboxNotAllowedError';
  }
}

/** Any other upstream failure; `status` = upstream HTTP status (0 = network / timeout). */
export class UpstreamHttpError extends AppError {
  constructor(
    public readonly service: LiveService,
    public readonly upstreamStatus: number,
    public readonly upstreamCode: string | null,
    statusCode: number,
    code: string,
    message: string,
  ) {
    super(statusCode, code, message, { service, upstreamStatus, upstreamCode });
    this.name = 'UpstreamHttpError';
  }
}

const SERVICE_LABEL: Record<LiveService, string> = {
  dataverse: 'CRM',
  graph: 'Microsoft 365',
  entra: 'Microsoft-Anmeldung',
};

/** Map an upstream HTTP status to a safe AppError. */
export function upstreamError(service: LiveService, status: number, upstreamCode: string | null): AppError {
  const label = SERVICE_LABEL[service];
  if (status === 0) return new UpstreamHttpError(service, 0, upstreamCode, 504, 'upstream_timeout', `${label} antwortet nicht – bitte später nochmals versuchen`);
  if (status === 403) return new UpstreamHttpError(service, status, upstreamCode, 403, 'upstream_forbidden', `Keine Berechtigung im ${label} für diese Aktion`);
  if (status === 404) return new UpstreamHttpError(service, status, upstreamCode, 404, 'upstream_not_found', `Im ${label} nicht gefunden`);
  if (status === 429 || status === 503)
    return new UpstreamHttpError(service, status, upstreamCode, 503, 'upstream_throttled', `${label} ist ausgelastet – bitte gleich nochmals versuchen`);
  if (status === 400 || status === 422)
    return new UpstreamHttpError(service, status, upstreamCode, 422, 'upstream_rejected', `${label} hat die Anfrage abgelehnt`);
  return new UpstreamHttpError(service, status, upstreamCode, 502, 'upstream_error', `${label} ist nicht erreichbar`);
}

/** Short, safe text for per-operation results (shown in the push protocol). */
export function operationErrorText(err: unknown): string {
  if (err instanceof ConcurrencyConflictError) return 'Konflikt: Datensatz wurde inzwischen im CRM geändert';
  if (err instanceof AppError) return err.message;
  return 'Unerwarteter Fehler';
}
