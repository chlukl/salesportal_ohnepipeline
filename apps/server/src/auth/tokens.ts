/**
 * Encrypted Entra tokens per session (AES-256-GCM, key from TOKEN_ENC_KEY via HKDF). Used by live adapters for
 * On-Behalf-Of calls. Tokens never leave the server and are never logged.
 */
import { eq } from 'drizzle-orm';
import type { AppConfig } from '../config';
import type { Db } from '../db/client';
import { sessions } from '../db/schema';
import { decryptJson, deriveKey, encryptJson } from './crypto';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  /** Epoch ms. */
  expiresAt: number | null;
  scope: string | null;
}

function tokenKey(config: AppConfig): Buffer {
  if (!config.auth.tokenEncKey) throw new Error('TOKEN_ENC_KEY not configured');
  return deriveKey(config.auth.tokenEncKey, 'tokens');
}

export function encryptTokens(config: AppConfig, tokens: StoredTokens): string {
  return encryptJson(tokenKey(config), tokens);
}

export async function loadSessionTokens(db: Db, config: AppConfig, sessionIdHash: string): Promise<StoredTokens | null> {
  const [row] = await db.select({ tokensEnc: sessions.tokensEnc }).from(sessions).where(eq(sessions.idHash, sessionIdHash));
  if (!row?.tokensEnc) return null;
  try {
    return decryptJson<StoredTokens>(tokenKey(config), row.tokensEnc);
  } catch {
    return null;
  }
}

export async function saveSessionTokens(db: Db, config: AppConfig, sessionIdHash: string, tokens: StoredTokens): Promise<void> {
  await db
    .update(sessions)
    .set({ tokensEnc: encryptTokens(config, tokens), tokenExpiresAt: tokens.expiresAt ? new Date(tokens.expiresAt) : null })
    .where(eq(sessions.idHash, sessionIdHash));
}
