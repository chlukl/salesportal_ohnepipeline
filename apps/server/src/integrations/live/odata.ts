/**
 * OData v4 query building for the Dataverse Web API – injection-safe by construction:
 * - field names are validated identifiers (no free text reaches $select/$filter/$orderby),
 * - string literals are quoted with doubled single quotes, LIKE wildcards in contains/startswith are escaped,
 * - GUIDs are validated before they are used in a URL or filter,
 * - the final query string is percent-encoded.
 */
import { badRequest } from '../../lib/errors';

export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}(\/[A-Za-z_][A-Za-z0-9_]{0,99})?$/;
const ENTITY_SET_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

export function isGuid(value: unknown): value is string {
  return typeof value === 'string' && GUID_RE.test(value);
}

/** Validated, lower-case GUID; throws 400 otherwise (never put unvalidated ids into URLs). */
export function assertGuid(value: unknown, what = 'ID'): string {
  if (!isGuid(value)) throw badRequest(`Ungültige ${what}`, 'invalid_id');
  return value.toLowerCase();
}

export function assertField(name: string): string {
  if (!FIELD_RE.test(name)) throw new Error(`invalid OData field name: ${name.slice(0, 40)}`);
  return name;
}

export function assertEntitySet(name: string): string {
  if (!ENTITY_SET_RE.test(name)) throw new Error(`invalid entity set: ${name.slice(0, 40)}`);
  return name;
}

/** `leads(00000000-…)` */
export function entityPath(entitySet: string, id: string): string {
  return `${assertEntitySet(entitySet)}(${assertGuid(id)})`;
}

/** Quote a string literal: `O'Brien` → `'O''Brien'`. */
export function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Escape Dataverse LIKE wildcards (`%`, `_`, `[`) used by contains/startswith/endswith. */
export function escapeLike(value: string): string {
  return value.replace(/[[%_]/g, (c) => `[${c}]`);
}

export type ODataValue = string | number | boolean | null | Date | { guid: string };

/** Literal for a $filter expression. */
export function literal(value: ODataValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid OData number');
    return String(value);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('invalid OData date');
    return value.toISOString();
  }
  if (typeof value === 'object') return assertGuid(value.guid);
  return quote(value);
}

/** Filter expression builders. Every builder returns a complete, parenthesised expression string. */
export const f = {
  eq: (field: string, value: ODataValue) => `${assertField(field)} eq ${literal(value)}`,
  ne: (field: string, value: ODataValue) => `${assertField(field)} ne ${literal(value)}`,
  gt: (field: string, value: ODataValue) => `${assertField(field)} gt ${literal(value)}`,
  ge: (field: string, value: ODataValue) => `${assertField(field)} ge ${literal(value)}`,
  lt: (field: string, value: ODataValue) => `${assertField(field)} lt ${literal(value)}`,
  le: (field: string, value: ODataValue) => `${assertField(field)} le ${literal(value)}`,
  contains: (field: string, value: string) => `contains(${assertField(field)},${quote(escapeLike(value))})`,
  startswith: (field: string, value: string) => `startswith(${assertField(field)},${quote(escapeLike(value))})`,
  endswith: (field: string, value: string) => `endswith(${assertField(field)},${quote(escapeLike(value))})`,
  and: (...parts: (string | null | undefined | false)[]) => join(parts, 'and'),
  or: (...parts: (string | null | undefined | false)[]) => join(parts, 'or'),
  not: (expr: string) => `not (${expr})`,
  /** `field eq v1 or field eq v2 …` (for option sets / strings). Empty list → always false. */
  anyOf: (field: string, values: ODataValue[]) =>
    values.length === 0 ? 'false' : join(values.map((v) => `${assertField(field)} eq ${literal(v)}`), 'or'),
  /**
   * Dataverse `In` query function for many GUIDs (lookups use the logical name, e.g. `regardingobjectid`).
   * Empty list → always false.
   */
  inGuids: (logicalName: string, ids: string[]) => {
    if (ids.length === 0) return 'false';
    const values = ids.map((id) => `'${assertGuid(id)}'`).join(',');
    return `Microsoft.Dynamics.CRM.In(PropertyName=${quote(assertField(logicalName))},PropertyValues=[${values}])`;
  },
};

function join(parts: (string | null | undefined | false)[], op: 'and' | 'or'): string {
  // `true` / `false` are folded here so they never reach Dataverse (callers skip requests whose filter is `false`).
  const neutral = op === 'and' ? 'true' : 'false';
  const absorbing = op === 'and' ? 'false' : 'true';
  const list = parts.filter((p): p is string => typeof p === 'string' && p.length > 0 && p !== neutral);
  if (list.includes(absorbing)) return absorbing;
  if (list.length === 0) return neutral;
  if (list.length === 1) return list[0];
  return list.map((p) => `(${p})`).join(` ${op} `);
}

export interface QueryOptions {
  select?: string[];
  filter?: string | null;
  orderby?: { field: string; dir?: 'asc' | 'desc' }[];
  top?: number;
  expand?: string;
  count?: boolean;
}

/** Build `?$select=…&$filter=…` (percent-encoded). */
export function buildQuery(q: QueryOptions): string {
  const params: string[] = [];
  if (q.select?.length) params.push(`$select=${q.select.map(assertField).join(',')}`);
  if (q.filter && q.filter !== 'true') params.push(`$filter=${encodeURIComponent(q.filter)}`);
  if (q.orderby?.length) {
    params.push(`$orderby=${encodeURIComponent(q.orderby.map((o) => `${assertField(o.field)} ${o.dir ?? 'asc'}`).join(','))}`);
  }
  if (q.top != null) {
    if (!Number.isInteger(q.top) || q.top < 1 || q.top > 5000) throw new Error('invalid $top');
    params.push(`$top=${q.top}`);
  }
  if (q.expand) params.push(`$expand=${encodeURIComponent(q.expand)}`);
  if (q.count) params.push('$count=true');
  return params.length ? `?${params.join('&')}` : '';
}

/** Split a list into chunks (URL length limits for `In` filters). */
export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Run async tasks with a concurrency limit, keeping order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
