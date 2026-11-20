/**
 * Adapter factory. Route handlers use `adaptersFor(request)` (acts on behalf of the logged-in user);
 * jobs use `ctx.adapters.system()` (app registration).
 */
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config';
import type { Db } from '../db/client';
import type { Logger } from '../lib/logger';
import { createAiAdapter, type AiAdapter } from './ai';
import { createCalendarAdapter, type CalendarAdapter } from './calendar';
import { createCrmAdapter, type CrmAdapter } from './crm';
import { createMailAdapter, type MailAdapter } from './mail';
import { createTelephonyAdapter, type TelephonyAdapter } from './telephony';
import { createTranscriptAdapter, type TranscriptAdapter } from './transcripts';
import type { AdapterAuth, AdapterDeps } from './types';

export type { AdapterAuth, AdapterDeps } from './types';

export interface Adapters {
  crm: CrmAdapter;
  calendar: CalendarAdapter;
  mail: MailAdapter;
  ai: AiAdapter;
  transcripts: TranscriptAdapter;
  telephony: TelephonyAdapter;
}

export interface AdapterFactory {
  forAuth(auth: AdapterAuth): Adapters;
  /** Background jobs (app registration). */
  system(): Adapters;
}

export function createAdapterFactory(base: { config: AppConfig; db: Db; log: Logger; now?: () => Date }): AdapterFactory {
  const now = base.now ?? (() => new Date());
  const build = (auth: AdapterAuth): Adapters => {
    const deps: AdapterDeps = { config: base.config, db: base.db, log: base.log, auth, now };
    return {
      crm: createCrmAdapter(deps),
      calendar: createCalendarAdapter(deps),
      mail: createMailAdapter(deps),
      ai: createAiAdapter(deps),
      transcripts: createTranscriptAdapter(deps),
      telephony: createTelephonyAdapter(deps),
    };
  };
  let systemAdapters: Adapters | null = null;
  return {
    forAuth: build,
    system: () => (systemAdapters ??= build({ kind: 'system' })),
  };
}

/** Adapters acting on behalf of the authenticated user of this request. */
export function adaptersFor(request: FastifyRequest): Adapters {
  const auth = request.auth;
  if (!auth) return request.server.adapters.system();
  return request.server.adapters.forAuth({
    kind: 'user',
    userId: auth.user.id,
    email: auth.user.email,
    sessionIdHash: auth.sessionIdHash,
  });
}
