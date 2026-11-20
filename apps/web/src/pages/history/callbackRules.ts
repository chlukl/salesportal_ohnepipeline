/**
 * Pure rules of the header search (INTENT 6.18). No React / DOM here – tested from the server's vitest
 * (`apps/server/src/modules/history/callbackRules.test.ts`).
 */
import type { CallbackHit, CallbackSearchResponse } from '@sales-portal/shared';

export type HitAction = 'callback' | 'open' | 'assign' | 'none';

/**
 * What Enter (or a click on the row) does with a hit.
 * - Number search: the phone is ringing → «Rückruf annehmen» (inbound call session) is the default.
 * - Name / company search: the user is looking something up → just open the lead; a call is only started on request.
 * `alternate` (Ctrl+Enter / the second button) swaps the two. Hits without a lead can only be assigned to one.
 */
export function hitAction(mode: CallbackSearchResponse['mode'] | undefined, hit: Pick<CallbackHit, 'leadId' | 'phoneE164'>, alternate = false): HitAction {
  if (!hit.leadId) return mode === 'phone' || hit.phoneE164 ? 'assign' : 'none';
  const primary: HitAction = mode === 'phone' ? 'callback' : 'open';
  if (!alternate) return primary;
  return primary === 'callback' ? 'open' : 'callback';
}

export const HIT_ACTION_LABELS: Record<HitAction, string> = {
  callback: 'Rückruf annehmen',
  open: 'Lead öffnen',
  assign: 'Nummer zuordnen',
  none: '',
};
