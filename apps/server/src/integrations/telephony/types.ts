/** Telephony: dial links only – Teams reports neither pick-up nor hang-up (clicks «Verbunden» / «Aufgelegt»). */

export interface DialTarget {
  /** Teams deeplink `https://teams.microsoft.com/l/call/0/0?users=4:<e164>` (null in mock = simulated call). */
  teamsUrl: string | null;
  /** `tel:` URI as fallback (null in mock). */
  telUrl: string | null;
  /** true in mock mode: the UI simulates the call, nothing is dialed (demo numbers are invented). */
  simulated: boolean;
}

export interface TelephonyAdapter {
  readonly mode: 'mock' | 'live';
  /** `e164` must be a normalized number (`+41611234567`). */
  dialTarget(e164: string): DialTarget;
}
