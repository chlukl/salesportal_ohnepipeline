/**
 * Live Vera adapter (VERA_API_URL / VERA_API_KEY). The real transfer path is still open (INTENT open question 2), so this
 * is a generic, configurable pull client. Assumed API (adjust the mapping here once Vera's API is known):
 *
 *   GET {VERA_API_URL}/v1/calls/{ref}/transcript         → { status, call: { id, startedAt, endedAt, durationSec }, segments: [{ speaker, start, text }] }
 *   GET {VERA_API_URL}/v1/calls?user=&from=&to=          → { items: [{ id, startedAt, endedAt, phone }] }   (lookup when no ref is known)
 *
 * Auth: `Authorization: Bearer <VERA_API_KEY>`. Timeouts and response size limits; responses are zod-validated.
 * The transcript content is never logged.
 */
import type { TranscriptSegment } from '@sales-portal/shared';
import { z } from 'zod';
import { upstreamError } from '../../lib/errors';
import type { AdapterDeps } from '../types';
import type { TranscriptAdapter, TranscriptFetchResult, TranscriptRef } from './types';

const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const LOOKUP_WINDOW_MS = 10 * 60_000;

const TranscriptResponse = z.object({
  status: z.enum(['processing', 'pending', 'completed', 'ready', 'failed', 'not_found']),
  call: z
    .object({
      id: z.string().min(1).max(200),
      startedAt: z.string().datetime({ offset: true }).nullable().optional(),
      endedAt: z.string().datetime({ offset: true }).nullable().optional(),
      durationSec: z.number().int().nonnegative().max(24 * 3600).nullable().optional(),
    })
    .optional(),
  segments: z
    .array(
      z.object({
        speaker: z.string().max(40),
        start: z.number().nonnegative().max(24 * 3600),
        text: z.string().max(20_000),
      }),
    )
    .max(5000)
    .optional(),
});

const CallList = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        startedAt: z.string().datetime({ offset: true }),
        endedAt: z.string().datetime({ offset: true }).nullable().optional(),
        phone: z.string().max(40).nullable().optional(),
      }),
    )
    .max(500),
});

export function mapSpeaker(value: string): TranscriptSegment['speaker'] {
  const v = value.toLowerCase();
  if (['agent', 'caller', 'user', 'internal', 'host'].includes(v)) return 'caller';
  if (['customer', 'callee', 'external', 'guest', 'contact'].includes(v)) return 'callee';
  return 'unknown';
}

export class LiveTranscriptAdapter implements TranscriptAdapter {
  readonly mode = 'live' as const;

  constructor(private readonly deps: AdapterDeps) {}

  private baseUrl(): URL {
    const { url, apiKey } = this.deps.config.vera;
    if (!url || !apiKey) throw upstreamError('Vera ist nicht konfiguriert', 'vera_not_configured');
    const base = new URL(url);
    if (this.deps.config.isProd && base.protocol !== 'https:') throw upstreamError('Vera-URL muss https sein', 'vera_not_configured');
    return base;
  }

  private async getJson(path: string, params?: Record<string, string>): Promise<unknown> {
    const base = this.baseUrl();
    const u = new URL(path.replace(/^\//, ''), base.href.endsWith('/') ? base.href : `${base.href}/`);
    for (const [k, v] of Object.entries(params ?? {})) u.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetch(u, {
        headers: { Authorization: `Bearer ${this.deps.config.vera.apiKey}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw upstreamError('Vera nicht erreichbar', 'vera_unavailable');
    }
    if (res.status === 404) return { status: 'not_found' };
    if (!res.ok) {
      this.deps.log.warn({ status: res.status }, 'vera request failed');
      throw upstreamError('Vera nicht erreichbar', 'vera_unavailable');
    }
    const length = Number(res.headers.get('content-length') ?? '0');
    if (length > MAX_RESPONSE_BYTES) throw upstreamError('Vera-Antwort zu gross', 'vera_invalid');
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw upstreamError('Vera-Antwort zu gross', 'vera_invalid');
    try {
      return JSON.parse(text);
    } catch {
      throw upstreamError('Vera-Antwort ungültig', 'vera_invalid');
    }
  }

  /** Find the Vera call id for a portal call (user + time window, optionally phone). */
  private async lookupRef(ref: TranscriptRef): Promise<string | null> {
    const anchor = ref.startedAt ?? ref.endedAt;
    if (!anchor) return null;
    const t = new Date(anchor).getTime();
    const parsed = CallList.safeParse(
      await this.getJson('v1/calls', {
        user: ref.userEmail,
        from: new Date(t - LOOKUP_WINDOW_MS).toISOString(),
        to: new Date(t + LOOKUP_WINDOW_MS).toISOString(),
      }),
    );
    if (!parsed.success) throw upstreamError('Vera-Antwort ungültig', 'vera_invalid');
    const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '').slice(-9);
    const candidates = parsed.data.items
      .filter((c) => !ref.phoneE164 || !c.phone || digits(c.phone) === digits(ref.phoneE164))
      .sort((a, b) => Math.abs(new Date(a.startedAt).getTime() - t) - Math.abs(new Date(b.startedAt).getTime() - t));
    return candidates[0]?.id ?? null;
  }

  async fetchTranscript(ref: TranscriptRef): Promise<TranscriptFetchResult> {
    const externalRef = ref.externalRef ?? (await this.lookupRef(ref));
    if (!externalRef) return { status: 'pending' };
    const parsed = TranscriptResponse.safeParse(await this.getJson(`v1/calls/${encodeURIComponent(externalRef)}/transcript`));
    if (!parsed.success) throw upstreamError('Vera-Antwort ungültig', 'vera_invalid');
    const data = parsed.data;
    if (data.status === 'processing' || data.status === 'pending' || data.status === 'not_found') return { status: 'pending' };
    if (data.status === 'failed') return { status: 'unavailable', reason: 'Vera konnte kein Transkript erstellen' };
    const segments = (data.segments ?? []).map((s) => ({ speaker: mapSpeaker(s.speaker), startSec: s.start, text: s.text }));
    if (segments.length === 0) return { status: 'unavailable', reason: 'Transkript ist leer' };
    return {
      status: 'ready',
      transcript: {
        callSessionId: ref.callSessionId,
        leadId: null,
        source: 'vera',
        externalRef: data.call?.id ?? externalRef,
        startedAt: data.call?.startedAt ?? null,
        endedAt: data.call?.endedAt ?? null,
        durationSec: data.call?.durationSec ?? null,
        segments,
      },
    };
  }
}
