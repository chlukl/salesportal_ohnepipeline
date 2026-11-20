/** Crypto helpers: session id hashing, random tokens, AES-256-GCM for tokens at rest, constant-time compare. */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 bytes of randomness, base64url. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Stored session key: HMAC-SHA256(SESSION_SECRET, raw session id). The raw id only lives in the cookie. */
export function hashSessionId(secret: string, rawId: string): string {
  return createHmac('sha256', secret).update(rawId).digest('hex');
}

/** Constant-time string comparison (false for different lengths without leaking timing of the content). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // Compare against itself to keep timing similar.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** Derive a purpose-specific 32-byte key from the master key (HKDF-SHA256). */
export function deriveKey(master: Buffer, purpose: 'tokens' | 'oidc-flow'): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `sales-portal:${purpose}`, 32));
}

/** AES-256-GCM: returns base64url(iv[12] | tag[16] | ciphertext). */
export function encryptJson(key: Buffer, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

export function decryptJson<T>(key: Buffer, payload: string): T {
  const raw = Buffer.from(payload, 'base64url');
  if (raw.length < 29) throw new Error('ciphertext too short');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as T;
}
