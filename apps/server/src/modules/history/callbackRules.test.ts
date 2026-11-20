/** Header search rules (apps/web/src/pages/history/callbackRules.ts) – the web app has no own test runner. */
import { describe, expect, it } from 'vitest';
import { hitAction } from '../../../../web/src/pages/history/callbackRules';

const lead = { leadId: 'L1', phoneE164: '+41615550102' };

describe('hitAction (Enter in the header search)', () => {
  it('number search: Enter takes the callback, Ctrl+Enter only opens', () => {
    expect(hitAction('phone', lead)).toBe('callback');
    expect(hitAction('phone', lead, true)).toBe('open');
  });

  it('name / company search: Enter only opens the lead – no inbound call session', () => {
    expect(hitAction('name', lead)).toBe('open');
    expect(hitAction('name', { leadId: 'L1', phoneE164: null })).toBe('open');
    // A callback from a name hit only on explicit request.
    expect(hitAction('name', lead, true)).toBe('callback');
    // Unknown mode (results not loaded yet) never starts a call.
    expect(hitAction(undefined, lead)).toBe('open');
  });

  it('hits without a lead can only be assigned (when there is a number)', () => {
    expect(hitAction('phone', { leadId: null, phoneE164: '+41445550123' })).toBe('assign');
    expect(hitAction('phone', { leadId: null, phoneE164: null })).toBe('assign');
    expect(hitAction('name', { leadId: null, phoneE164: null })).toBe('none');
    expect(hitAction('name', { leadId: null, phoneE164: '+41445550123' }, true)).toBe('assign');
  });
});
