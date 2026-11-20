/**
 * pino logger with redaction of personal data and secrets (ARCHITECTURE §5.8).
 * Never log request bodies; log ids, not names / phone numbers / note texts.
 */
import pino, { type LoggerOptions } from 'pino';

/** Field names that must never appear in logs in plain text (any nesting depth up to 3). */
const SENSITIVE_KEYS = [
  'password',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'access_token',
  'refresh_token',
  'id_token',
  'code_verifier',
  'csrfToken',
  'authorization',
  'cookie',
  'set-cookie',
  'x-csrf-token',
  'email',
  'emailaddress1',
  'phone',
  'phoneE164',
  'phoneDisplay',
  'telephone1',
  'mobilephone',
  'phonenumber',
  'note',
  'noteDraft',
  'notes',
  'text',
  'description',
  'body',
  'transcript',
  'segments',
  'apiKey',
];

function redactPaths(): string[] {
  const paths: string[] = ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'];
  for (const key of SENSITIVE_KEYS) {
    // Header names with dashes are covered by the explicit req/res paths above.
    if (!/^[a-zA-Z_]\w*$/.test(key)) continue;
    paths.push(key, `*.${key}`, `*.*.${key}`);
  }
  return paths;
}

// ---------------------------------------------------------------------------------------------------------------------
// Error sanitising (ARCHITECTURE §5.8): drizzle wraps every failed query in a DrizzleQueryError whose message is
// `Failed query: <sql>\nparams: <all bound values>` and which carries `.query` / `.params`. Bound values are personal
// data or secrets (note texts, e-mails, phone numbers, session hashes, CSRF tokens) and must never reach logs or
// `jobs.last_error`. Redaction by key name does not help here – the values sit inside a string.
// ---------------------------------------------------------------------------------------------------------------------

/** `\nparams: …` up to the first stack frame (or the end). Params may contain newlines (note texts). */
const PARAMS_SECTION = /\nparams: [\s\S]*?(?=\n\s+at |$)/g;

/** Fields of a Postgres error (pg / PGlite) that never contain bound values. `detail`, `where`, `hint` may – dropped. */
const PG_SAFE_FIELDS = ['code', 'constraint', 'table', 'column', 'schema', 'dataType', 'severity', 'routine'] as const;

type DbQueryError = Error & { query: string; params: unknown };

/** drizzle-orm's DrizzleQueryError (duck-typed: the class is not exported from the package root in every version). */
export function isDbQueryError(err: unknown): err is DbQueryError {
  return err instanceof Error && typeof (err as Partial<DbQueryError>).query === 'string' && 'params' in err;
}

function pgDetails(cause: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cause || typeof cause !== 'object') return out;
  for (const key of PG_SAFE_FIELDS) {
    const v = (cause as Record<string, unknown>)[key];
    if (typeof v === 'string' && v) out[key] = v.slice(0, 120);
  }
  return out;
}

/** Remove the bound-parameter section of a drizzle «Failed query» text (also inside a wrapping message or a stack). */
export function stripQueryParams(text: string): string {
  return text.replace(PARAMS_SECTION, '\nparams: [redacted]');
}

/**
 * Message of an error that is safe to log or store (e.g. `jobs.last_error`, shown in Admin › Fehler):
 * for failed DB queries only the SQL text (placeholders, no values) plus the Postgres error code / constraint.
 */
export function safeErrorMessage(err: unknown): string {
  if (isDbQueryError(err)) {
    const d = pgDetails(err.cause);
    const pg = d.code ? ` [pg ${d.code}${d.constraint ? ` ${d.constraint}` : ''}]` : '';
    return `Failed query: ${err.query.slice(0, 400)}${pg}`;
  }
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);
  return stripQueryParams(message);
}

/** Stack frames only (the first stack line repeats the message, which may contain query params). */
function framesOnly(stack: unknown): string | undefined {
  if (typeof stack !== 'string') return undefined;
  const frames = stack.split('\n').filter((l) => /^\s+at /.test(l));
  return frames.length ? frames.join('\n') : undefined;
}

const MAX_CAUSE_DEPTH = 4;

/** pino `err` serializer: standard error output, but DB query errors without params and pg errors without `detail`. */
export function serializeError(err: unknown, depth = 0): unknown {
  if (!(err instanceof Error)) {
    // `{ err: { message } }` call sites log a plain object with the raw message.
    if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
      return { ...(err as Record<string, unknown>), message: stripQueryParams((err as { message: string }).message) };
    }
    return typeof err === 'string' ? stripQueryParams(err) : err;
  }
  if (isDbQueryError(err)) {
    return { type: 'DrizzleQueryError', message: safeErrorMessage(err), ...pgDetails(err.cause), stack: framesOnly(err.stack) };
  }
  const s = { ...(pino.stdSerializers.err(err) as unknown as Record<string, unknown>) };
  if (typeof s.message === 'string') s.message = stripQueryParams(s.message);
  if (typeof s.stack === 'string') s.stack = stripQueryParams(s.stack);
  // Postgres errors: `detail` («Key (email)=(…) already exists»), `where`, `hint`, `internalQuery` may contain values.
  for (const key of ['detail', 'where', 'hint', 'internalQuery', 'query', 'params', 'parameters']) delete s[key];
  if (err.cause !== undefined) s.cause = depth < MAX_CAUSE_DEPTH ? serializeError(err.cause, depth + 1) : '[cause]';
  return s;
}

export function loggerOptions(level: string, pretty: boolean): LoggerOptions {
  return {
    level,
    redact: { paths: redactPaths(), censor: '[redacted]' },
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      // Query strings may contain search terms / phone numbers → log the path only.
      req: (req: { id?: string; method?: string; url?: string }) => ({
        id: req.id,
        method: req.method,
        url: typeof req.url === 'string' ? req.url.split('?')[0] : undefined,
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      // Failed DB queries carry all bound values (notes, e-mails, CSRF tokens …) in message/params → sanitised.
      err: serializeError,
    },
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } }
      : {}),
  };
}

export function createLogger(level: string, pretty = false) {
  return pino(loggerOptions(level, pretty));
}

export type Logger = ReturnType<typeof createLogger>;
