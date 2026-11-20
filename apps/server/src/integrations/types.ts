/** Shared dependency types for all adapters. */
import type { AppConfig } from '../config';
import type { Db } from '../db/client';
import type { Logger } from '../lib/logger';

/**
 * On whose behalf an adapter call runs.
 * - `user`: delegated (On-Behalf-Of) – CRM changes appear as that user, mails from their mailbox.
 * - `system`: background jobs with the portal's app registration (blockers, delta queries, retention).
 */
export type AdapterAuth =
  | {
      kind: 'user';
      userId: string;
      email: string;
      /** Session id hash – used by live adapters to load the encrypted Entra tokens of this session. */
      sessionIdHash: string | null;
    }
  | { kind: 'system' };

export interface AdapterDeps {
  config: AppConfig;
  db: Db;
  log: Logger;
  auth: AdapterAuth;
  /** Injectable clock (tests). */
  now: () => Date;
}
