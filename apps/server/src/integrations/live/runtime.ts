/**
 * Shared runtime of the live adapters: one HTTP client + one token service (with its cache) per configuration.
 * Adapters are created per request (`adaptersFor`), so the token cache must live here, not in the adapter.
 * Tests inject their own runtime (mocked fetch, no sleeping).
 */
import type { AppConfig } from '../../config';
import type { Logger } from '../../lib/logger';
import { HttpClient, type HttpClientOptions } from './http';
import { EntraTokenService } from './tokens';

export interface LiveRuntime {
  http: HttpClient;
  tokens: EntraTokenService;
}

const runtimes = new WeakMap<AppConfig, LiveRuntime>();

export function createLiveRuntime(
  config: AppConfig,
  log: Pick<Logger, 'debug' | 'warn' | 'info'>,
  httpOptions: HttpClientOptions = {},
  now: () => number = Date.now,
): LiveRuntime {
  const http = new HttpClient({ timeoutMs: config.live.httpTimeoutMs, log, now, ...httpOptions });
  return { http, tokens: new EntraTokenService(config, http, log, now) };
}

export function getLiveRuntime(config: AppConfig, log: Logger): LiveRuntime {
  let rt = runtimes.get(config);
  if (!rt) {
    rt = createLiveRuntime(config, log.child({ component: 'live-integrations' }));
    runtimes.set(config, rt);
  }
  return rt;
}
