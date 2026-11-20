/**
 * Dataverse Web API v9.2 client: OData queries with paging (@odata.nextLink), formatted values (Prefer header),
 * ETags / If-Match for optimistic concurrency, `$batch` change sets, typed errors.
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from '../../lib/logger';
import { ConcurrencyConflictError, upstreamError } from './errors';
import { upstreamCodeOf, type HttpClient, type HttpResponse, type RetryMode } from './http';
import { assertEntitySet, assertGuid, buildQuery, entityPath, type QueryOptions } from './odata';

export const FORMATTED = 'OData.Community.Display.V1.FormattedValue';
export const LOOKUP_LOGICAL_NAME = 'Microsoft.Dynamics.CRM.lookuplogicalname';
const ANNOTATIONS = `odata.include-annotations="${FORMATTED},${LOOKUP_LOGICAL_NAME}"`;

export type DvRow = Record<string, unknown>;

export interface BatchOperation {
  method: 'POST' | 'PATCH' | 'DELETE';
  /** Relative to the API base, e.g. `leads(<id>)`. */
  path: string;
  body?: DvRow;
  etag?: string | null;
}

export interface BatchOperationResult {
  status: number;
  /** Created record id (from OData-EntityId) for POST. */
  id: string | null;
  errorCode: string | null;
}

export interface DataverseClientOptions {
  /** e.g. `https://org.crm4.dynamics.com` */
  url: string;
  http: HttpClient;
  getToken: () => Promise<string>;
  log?: Pick<Logger, 'warn' | 'debug'>;
  /** Max rows per page (Prefer odata.maxpagesize), ≤ 5000. */
  pageSize?: number;
}

export class DataverseClient {
  readonly apiBase: string;

  constructor(private readonly opts: DataverseClientOptions) {
    this.apiBase = `${new URL(opts.url).origin}/api/data/v9.2/`;
  }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.opts.getToken()}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      ...extra,
    };
  }

  private fail(res: HttpResponse, entity: string, id?: string): never {
    const code = upstreamCodeOf(res);
    if (res.status === 412) throw new ConcurrencyConflictError(entity, id ?? '');
    this.opts.log?.warn({ status: res.status, error: code, entity }, 'dataverse request failed');
    throw upstreamError('dataverse', res.status, code);
  }

  /** GET a collection with paging; stops after `maxRows`. A filter of `false` short-circuits to []. */
  async list<T extends DvRow = DvRow>(entitySet: string, query: QueryOptions, options: { maxRows?: number } = {}): Promise<T[]> {
    if (query.filter === 'false') return [];
    const maxRows = options.maxRows ?? 5000;
    const pageSize = Math.min(this.opts.pageSize ?? 500, 5000, query.top ?? 5000);
    let url: string | null = `${this.apiBase}${assertEntitySet(entitySet)}${buildQuery(query)}`;
    const rows: T[] = [];
    let pages = 0;
    while (url && rows.length < maxRows) {
      const res = await this.opts.http.send({
        service: 'dataverse',
        method: 'GET',
        url,
        headers: await this.headers({ Prefer: `${ANNOTATIONS},odata.maxpagesize=${pageSize}` }),
      });
      if (res.status !== 200) this.fail(res, entitySet);
      const body = res.json<{ value?: T[]; '@odata.nextLink'?: string }>();
      rows.push(...(body.value ?? []));
      pages++;
      // $top caps the total; never follow links to other hosts (the token must only go to Dataverse).
      const next = body['@odata.nextLink'];
      url = query.top == null && next && next.startsWith(this.apiBase) && pages < 1000 ? next : null;
    }
    return rows.slice(0, maxRows);
  }

  /** GET one record; null when it does not exist. Returns the ETag for If-Match. */
  async get<T extends DvRow = DvRow>(entitySet: string, id: string, select?: string[]): Promise<{ row: T; etag: string | null } | null> {
    const res = await this.opts.http.send({
      service: 'dataverse',
      method: 'GET',
      url: `${this.apiBase}${entityPath(entitySet, id)}${buildQuery({ select })}`,
      headers: await this.headers({ Prefer: ANNOTATIONS }),
    });
    if (res.status === 404) return null;
    if (res.status !== 200) this.fail(res, entitySet, id);
    const row = res.json<T>();
    const etag = (row['@odata.etag'] as string | undefined) ?? res.headers.get('etag');
    return { row, etag: etag ?? null };
  }

  /** POST a record; returns its id (from the OData-EntityId header). Not retried except on 429. */
  async create(entitySet: string, body: DvRow): Promise<string> {
    const res = await this.opts.http.send({
      service: 'dataverse',
      method: 'POST',
      url: `${this.apiBase}${assertEntitySet(entitySet)}`,
      headers: await this.headers({ 'Content-Type': 'application/json; charset=utf-8' }),
      body: JSON.stringify(body),
      retry: 'throttle_only',
    });
    if (res.status !== 204 && res.status !== 201) this.fail(res, entitySet);
    const id = idFromEntityId(res.headers.get('odata-entityid')) ?? (res.status === 201 ? idFromBody(res, entitySet) : null);
    if (!id) throw upstreamError('dataverse', 502, 'missing_entity_id');
    return id;
  }

  /**
   * PATCH a record. `etag` = optimistic concurrency (412 → ConcurrencyConflictError); without it `If-Match: *`
   * prevents Dataverse from silently creating the record (upsert).
   */
  async update(entitySet: string, id: string, body: DvRow, options: { etag?: string | null } = {}): Promise<void> {
    const res = await this.opts.http.send({
      service: 'dataverse',
      method: 'PATCH',
      url: `${this.apiBase}${entityPath(entitySet, id)}`,
      headers: await this.headers({ 'Content-Type': 'application/json; charset=utf-8', 'If-Match': options.etag ?? '*' }),
      body: JSON.stringify(body),
      retry: 'idempotent',
    });
    if (res.status === 404) this.fail(res, entitySet, id);
    if (res.status !== 204 && res.status !== 200) this.fail(res, entitySet, id);
  }

  async delete(entitySet: string, id: string): Promise<void> {
    const res = await this.opts.http.send({
      service: 'dataverse',
      method: 'DELETE',
      url: `${this.apiBase}${entityPath(entitySet, id)}`,
      headers: await this.headers(),
    });
    if (res.status !== 204 && res.status !== 404) this.fail(res, entitySet, id);
  }

  /**
   * Execute operations as ONE atomic `$batch` change set (all or nothing, in order).
   * 412 on any operation → ConcurrencyConflictError; other failures → upstream error.
   */
  async changeSet(ops: BatchOperation[], retry: RetryMode = 'throttle_only'): Promise<BatchOperationResult[]> {
    if (ops.length === 0) return [];
    const batchId = `batch_${randomUUID()}`;
    const changesetId = `changeset_${randomUUID()}`;
    const body = buildChangeSetBody(this.apiBase, batchId, changesetId, ops);
    const res = await this.opts.http.send({
      service: 'dataverse',
      method: 'POST',
      url: `${this.apiBase}$batch`,
      headers: await this.headers({ 'Content-Type': `multipart/mixed; boundary=${batchId}` }),
      body,
      retry,
    });
    if (res.status !== 200) this.fail(res, '$batch');
    const parts = parseBatchResponse(res.text);
    const failed = parts.find((p) => p.status >= 400);
    if (failed) {
      if (failed.status === 412) {
        const op = ops[(failed.contentId ?? 1) - 1];
        throw new ConcurrencyConflictError(op?.path.split('(')[0] ?? 'record', op?.path.match(/\(([^)]+)\)/)?.[1] ?? '');
      }
      this.opts.log?.warn({ status: failed.status, error: failed.errorCode }, 'dataverse change set failed');
      throw upstreamError('dataverse', failed.status, failed.errorCode);
    }
    return ops.map((_, i) => {
      const part = parts.find((p) => p.contentId === i + 1) ?? parts[i];
      return { status: part?.status ?? 204, id: idFromEntityId(part?.headers['odata-entityid'] ?? null), errorCode: null };
    });
  }

  /** Current user (systemuserid) – diagnostics. */
  async whoAmI(): Promise<{ UserId: string }> {
    const res = await this.opts.http.send({ service: 'dataverse', method: 'GET', url: `${this.apiBase}WhoAmI`, headers: await this.headers() });
    if (res.status !== 200) this.fail(res, 'WhoAmI');
    return res.json<{ UserId: string }>();
  }
}

function idFromEntityId(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = header.match(/\(([0-9a-f-]{36})\)\s*$/i);
  return m ? m[1].toLowerCase() : null;
}

function idFromBody(res: HttpResponse, entitySet: string): string | null {
  try {
    const row = res.json<DvRow>();
    const key = `${entitySet.replace(/s$/, '')}id`;
    const v = row[key] ?? row.activityid;
    return typeof v === 'string' ? assertGuid(v) : null;
  } catch {
    return null;
  }
}

/** multipart/mixed body of a `$batch` request with one change set. */
export function buildChangeSetBody(apiBase: string, batchId: string, changesetId: string, ops: BatchOperation[]): string {
  const lines: string[] = [`--${batchId}`, `Content-Type: multipart/mixed; boundary=${changesetId}`, ''];
  ops.forEach((op, i) => {
    lines.push(`--${changesetId}`, 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', `Content-ID: ${i + 1}`, '');
    lines.push(`${op.method} ${apiBase}${op.path} HTTP/1.1`);
    if (op.body) lines.push('Content-Type: application/json; charset=utf-8');
    if (op.method === 'PATCH') lines.push(`If-Match: ${op.etag ?? '*'}`);
    lines.push('');
    lines.push(op.body ? JSON.stringify(op.body) : '');
  });
  lines.push(`--${changesetId}--`, '', `--${batchId}--`, '');
  return lines.join('\r\n');
}

export interface BatchResponsePart {
  status: number;
  contentId: number | null;
  headers: Record<string, string>;
  errorCode: string | null;
}

/** Parse the multipart `$batch` response into per-operation HTTP results (in order). */
export function parseBatchResponse(text: string): BatchResponsePart[] {
  const out: BatchResponsePart[] = [];
  // Every embedded response starts with its HTTP status line; the MIME headers before it carry the Content-ID.
  const re = /HTTP\/1\.1 (\d{3})[^\r\n]*\r?\n/g;
  let match: RegExpExecArray | null;
  const positions: { index: number; end: number; status: number }[] = [];
  while ((match = re.exec(text))) positions.push({ index: match.index, end: re.lastIndex, status: Number(match[1]) });
  positions.forEach((pos, i) => {
    const before = text.slice(i === 0 ? 0 : positions[i - 1].end, pos.index);
    const cid = before.match(/Content-ID:\s*(\d+)/i);
    const rest = text.slice(pos.end, i + 1 < positions.length ? positions[i + 1].index : text.length);
    const [headerBlock, ...bodyParts] = rest.split(/\r?\n\r?\n/);
    const headers: Record<string, string> = {};
    for (const line of headerBlock.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    let errorCode: string | null = null;
    if (pos.status >= 400) {
      const json = bodyParts.join('\n\n').match(/\{[\s\S]*\}/);
      try {
        const parsed = json ? (JSON.parse(json[0]) as { error?: { code?: string } }) : null;
        errorCode = parsed?.error?.code ?? null;
      } catch {
        errorCode = null;
      }
    }
    out.push({ status: pos.status, contentId: cid ? Number(cid[1]) : null, headers, errorCode });
  });
  return out;
}
