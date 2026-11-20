/** zod helpers for query strings (comma-separated lists, booleans, numbers). */
import { z } from 'zod';

/** `?grades=A,B` → ['A','B']; also accepts repeated params (`?grades=A&grades=B`). */
export function csv<T extends z.ZodType>(item: T, max = 100) {
  return z.preprocess((value) => {
    if (value == null || value === '') return undefined;
    const parts = (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(','));
    return parts.map((p) => p.trim()).filter(Boolean);
  }, z.array(item).max(max).optional());
}

/** `?x=true|false|1|0` → boolean. */
export const queryBool = z.preprocess((value) => {
  if (value == null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'ja'].includes(String(value).toLowerCase());
}, z.boolean().optional());

export const crmId = z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/, 'ungültige ID');
export const uuidParam = z.object({ id: z.string().uuid() });
export const isoDateTime = z.string().datetime({ offset: true });
