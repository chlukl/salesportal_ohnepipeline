/**
 * Small website research for the use-case mail (INTENT 6.7) with strict SSRF protection:
 *
 * - https only, default port only, no credentials in the URL, no IP literals that are not public
 * - DNS is resolved by us; EVERY resolved address must be public (no loopback/private/link-local/CGNAT/multicast/
 *   reserved, no IPv4-mapped private IPv6) and the connection is pinned to the checked address (no DNS rebinding)
 * - at most 2 redirects, each re-validated the same way (never to http or private ranges)
 * - total time limit and response size limit; only text/html or text/plain
 *
 * The extracted text is untrusted data and only ever passed to the AI inside a data block.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface ResearchOptions {
  resolver?: Resolver;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Test hook: performs the pinned request. */
  requester?: (url: URL, address: ResolvedAddress, signal: AbortSignal, maxBytes: number) => Promise<RawResponse>;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface ResearchResult {
  ok: boolean;
  url: string | null;
  /** Readable label for `sources`, e.g. «Website example.ch». */
  source: string | null;
  text: string | null;
  error: string | null;
}

export class ResearchBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResearchBlockedError';
  }
}

const DEFAULTS = { timeoutMs: 5_000, maxBytes: 512 * 1024, maxRedirects: 2 };
const MAX_TEXT_CHARS = 4_000;

// ---------------------------------------------------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------------------------------------------------

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inRange4(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const BLOCKED_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

/** Expand an IPv6 address into 8 hextets (handles `::` and embedded IPv4). */
function expandIpv6(ip: string): number[] | null {
  let addr = ip.toLowerCase().split('%')[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    addr = addr.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const parts = addr.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (parts.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const all = [...head, ...Array(parts.length === 2 ? missing : 0).fill('0'), ...tail];
  const nums = all.map((h) => parseInt(h, 16));
  return nums.length === 8 && nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? nums : null;
}

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !BLOCKED_V4.some((cidr) => inRange4(ip, cidr));
  if (family !== 6) return false;
  const h = expandIpv6(ip);
  if (!h) return false;
  if (h.every((x) => x === 0)) return false; // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return false; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible / NAT64 (64:ff9b::/96) → judge the embedded IPv4.
  const embedded = `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`;
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return isPublicAddress(embedded);
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return isPublicAddress(embedded);
  if (h.slice(0, 6).every((x) => x === 0)) return false; // deprecated IPv4-compatible
  if ((h[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((h[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((h[0] & 0xffc0) === 0xfec0) return false; // fec0::/10 site-local (deprecated)
  if ((h[0] & 0xff00) === 0xff00) return false; // multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return false; // documentation
  if (h[0] === 0x2002) return isPublicAddress(`${h[1] >> 8}.${h[1] & 0xff}.${h[2] >> 8}.${h[2] & 0xff}`); // 6to4
  if (h[0] === 0x0100 && h.slice(1, 4).every((x) => x === 0)) return false; // discard-only
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------------------------------------------------

/** Normalise a CRM website value («www.firma.ch», «https://firma.ch/») to an https URL or throw. */
export function normalizeResearchUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 500) throw new ResearchBlockedError('Keine gültige Website');
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ResearchBlockedError('Keine gültige Website');
  }
  return validateResearchUrl(url);
}

export function validateResearchUrl(url: URL): URL {
  if (url.protocol !== 'https:') throw new ResearchBlockedError('Nur https-Websites werden abgerufen');
  if (url.username || url.password) throw new ResearchBlockedError('URL mit Zugangsdaten ist nicht erlaubt');
  if (url.port && url.port !== '443') throw new ResearchBlockedError('Nur Standard-Port 443 ist erlaubt');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new ResearchBlockedError('Interne Adressen sind nicht erlaubt');
  }
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new ResearchBlockedError('Interne Adressen sind nicht erlaubt');
  } else if (!host.includes('.')) {
    throw new ResearchBlockedError('Interne Adressen sind nicht erlaubt');
  }
  return url;
}

const defaultResolver: Resolver = async (hostname) => {
  const all = await dnsLookup(hostname, { all: true, verbatim: true });
  return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/** Resolve and require that every address is public; returns the address to pin the connection to. */
export async function resolvePublic(hostname: string, resolver: Resolver = defaultResolver): Promise<ResolvedAddress> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new ResearchBlockedError('Interne Adressen sind nicht erlaubt');
    return { address: host, family: isIP(host) === 6 ? 6 : 4 };
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new ResearchBlockedError('Website nicht gefunden');
  }
  if (addresses.length === 0) throw new ResearchBlockedError('Website nicht gefunden');
  if (addresses.some((a) => !isPublicAddress(a.address))) throw new ResearchBlockedError('Website zeigt auf eine interne Adresse');
  return addresses[0];
}

// ---------------------------------------------------------------------------------------------------------------------
// Pinned request
// ---------------------------------------------------------------------------------------------------------------------

const pinnedRequest = (url: URL, address: ResolvedAddress, signal: AbortSignal, maxBytes: number): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: 'https:',
        hostname: url.hostname,
        servername: isIP(url.hostname) ? undefined : url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { 'User-Agent': 'SalesPortal-Research/1.0', Accept: 'text/html,text/plain;q=0.9', 'Accept-Encoding': 'identity' },
        signal,
        // Pin the connection to the validated address (prevents DNS rebinding between check and connect).
        lookup: (_hostname, options, callback) => {
          const cb = callback as unknown as (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void;
          if ((options as { all?: boolean }).all) cb(null, [{ address: address.address, family: address.family }]);
          else cb(null, address.address, address.family);
        },
      },
      (res) => {
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') });
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });

// ---------------------------------------------------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', eacute: 'é', egrave: 'è', agrave: 'à', szlig: 'ss' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 31 && code < 0x10ffff ? String.fromCodePoint(code) : ' ';
    }
    return ENTITIES[e] ?? m;
  });
}

/** Title, meta description and visible text of an HTML page (no markup, capped). */
export function extractText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  const description =
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ??
    /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(html)?.[1] ??
    '';
  const body = html
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const clean = (s: string) =>
    decodeEntities(s)
      .replace(/[ \t\r\f\v]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  const parts = [title && `Titel: ${clean(title)}`, description && `Beschreibung: ${clean(description)}`, clean(body)].filter(Boolean);
  return parts.join('\n').slice(0, MAX_TEXT_CHARS);
}

// ---------------------------------------------------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------------------------------------------------

/** Fetch the lead's website safely. Never throws – returns `ok: false` with a German reason instead. */
export async function researchWebsite(rawUrl: string | null | undefined, options: ResearchOptions = {}): Promise<ResearchResult> {
  if (!rawUrl) return { ok: false, url: null, source: null, text: null, error: 'Keine Website im CRM' };
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;
  const requester = options.requester ?? pinnedRequest;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    let url = normalizeResearchUrl(rawUrl);
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const address = await resolvePublic(url.hostname, options.resolver);
      const res = await requester(url, address, signal, maxBytes);
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.location;
        if (!location || hop === maxRedirects) throw new ResearchBlockedError('Zu viele Weiterleitungen');
        url = validateResearchUrl(new URL(location, url));
        continue;
      }
      if (res.status !== 200) throw new ResearchBlockedError('Website nicht abrufbar');
      const type = (res.headers['content-type'] ?? '').toLowerCase();
      if (type && !type.includes('text/html') && !type.includes('text/plain')) throw new ResearchBlockedError('Website liefert keinen Text');
      const text = type.includes('text/plain') ? res.body.slice(0, MAX_TEXT_CHARS) : extractText(res.body);
      return { ok: true, url: url.toString(), source: `Website ${url.hostname}`, text, error: null };
    }
    throw new ResearchBlockedError('Zu viele Weiterleitungen');
  } catch (err) {
    const message = err instanceof ResearchBlockedError ? err.message : signal.aborted ? 'Website antwortet zu langsam' : 'Website nicht abrufbar';
    return { ok: false, url: null, source: null, text: null, error: message };
  }
}
