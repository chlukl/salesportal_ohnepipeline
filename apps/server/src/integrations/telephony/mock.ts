/**
 * Mock telephony: never produces real dial links, because demo numbers are invented and could belong to real people.
 * The UI simulates dialing.
 */
import { badRequest } from '../../lib/errors';
import type { DialTarget, TelephonyAdapter } from './types';

export class MockTelephonyAdapter implements TelephonyAdapter {
  readonly mode = 'mock' as const;

  dialTarget(e164: string): DialTarget {
    if (!/^\+\d{8,15}$/.test(e164)) throw badRequest('Nummer prüfen');
    return { teamsUrl: null, telUrl: null, simulated: true };
  }
}
