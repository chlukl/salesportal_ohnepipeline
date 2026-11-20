/** Live telephony: Teams deeplink (Teams telephony) + tel: fallback (ARCHITECTURE §7). */
import { badRequest } from '../../lib/errors';
import type { DialTarget, TelephonyAdapter } from './types';

export class LiveTelephonyAdapter implements TelephonyAdapter {
  readonly mode = 'live' as const;

  dialTarget(e164: string): DialTarget {
    if (!/^\+\d{8,15}$/.test(e164)) throw badRequest('Nummer prüfen');
    return {
      teamsUrl: `https://teams.microsoft.com/l/call/0/0?users=4:${encodeURIComponent(e164)}`,
      telUrl: `tel:${e164}`,
      simulated: false,
    };
  }
}
