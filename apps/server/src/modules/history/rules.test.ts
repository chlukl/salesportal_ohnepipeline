import { RESULT_GROUP_CODES, type PhoneCall } from '@sales-portal/shared';
import { describe, expect, it } from 'vitest';
import { buildHistory, categorizeSession, filterHistory, isMissedOpen, matchesSearch, oneLine, type HistorySession } from './rules';

const T = (iso: string) => new Date(iso);

function call(partial: Partial<PhoneCall> & Pick<PhoneCall, 'id' | 'start'>): PhoneCall {
  return {
    leadId: 'L1',
    leadName: 'Anna Muster',
    companyName: 'Alpha AG',
    direction: 'outgoing',
    subject: 'Anruf',
    text: null,
    phoneNumber: '+41 61 555 01 02',
    phoneE164: '+41615550102',
    ownerId: 'c-markus',
    ownerName: 'Markus',
    end: null,
    durationSec: 60,
    resultCode: RESULT_GROUP_CODES.callback,
    interest: null,
    transcriptLink: null,
    ...partial,
  };
}

function session(partial: Partial<HistorySession> & Pick<HistorySession, 'id'>): HistorySession {
  return {
    leadId: 'L1',
    leadName: 'Anna Muster',
    companyName: 'Alpha AG',
    phoneE164: '+41615550102',
    phoneDisplay: '+41 61 555 01 02',
    direction: 'inbound',
    category: 'callback_missed',
    status: 'ended',
    reason: null,
    dialedAt: T('2026-11-18T09:00:00Z'),
    connectedAt: null,
    endedAt: null,
    durationSec: null,
    noteDraft: null,
    resultGroup: null,
    crmPhonecallId: null,
    handledAt: null,
    createdAt: T('2026-11-18T09:00:00Z'),
    ...partial,
  };
}

describe('oneLine', () => {
  it('collapses whitespace and truncates', () => {
    expect(oneLine('Kunde\nruft   zurück')).toBe('Kunde ruft zurück');
    expect(oneLine('x'.repeat(200), 20)).toHaveLength(20);
    expect(oneLine('   ')).toBeNull();
  });
});

describe('categories (6.15)', () => {
  it('CRM calls: outgoing → ausgehend, incoming → Rückruf angenommen', () => {
    const rows = buildHistory(
      [call({ id: 'p1', start: '2026-11-17T08:00:00Z' }), call({ id: 'p2', start: '2026-11-18T08:00:00Z', direction: 'incoming' })],
      [],
      [],
    );
    expect(rows.map((r) => [r.id, r.category, r.direction])).toEqual([
      ['pc:p2', 'callback_answered', 'inbound'],
      ['pc:p1', 'outbound', 'outbound'],
    ]);
    // Callback shows the last outgoing call before it (why Markus had called).
    expect(rows[0].lastOutbound).toEqual({ at: '2026-11-17T08:00:00.000Z', resultCode: RESULT_GROUP_CODES.callback });
  });

  it('a portal session linked to a CRM call is merged, not duplicated', () => {
    const rows = buildHistory(
      [call({ id: 'p9', start: '2026-11-18T10:00:00Z', direction: 'incoming', text: 'Rückruf wegen Offerte' })],
      [session({ id: 's9', category: 'callback_answered', crmPhonecallId: 'p9', connectedAt: T('2026-11-18T10:00:00Z') })],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'pc:p9', category: 'callback_answered', sessionId: 's9', notePreview: 'Rückruf wegen Offerte' });
  });

  it('unknown number becomes a callback once assigned to a lead', () => {
    const unknown = session({ id: 'u1', leadId: null, leadName: null, companyName: null, category: 'unknown_number', phoneE164: '+41445550123' });
    expect(categorizeSession(unknown, null)).toBe('unknown_number');
    const assignment = { phoneE164: '+41445550123', leadId: 'L7', leadName: 'Beat Beispiel', companyName: 'Beta GmbH' };
    expect(categorizeSession(unknown, assignment)).toBe('callback_missed');
    expect(categorizeSession({ ...unknown, connectedAt: T('2026-11-18T09:00:00Z') }, assignment)).toBe('callback_answered');

    const [before] = buildHistory([], [unknown], []);
    expect(before).toMatchObject({ category: 'unknown_number', assignable: true, open: false, leadId: null });
    const [after] = buildHistory([], [unknown], [assignment]);
    expect(after).toMatchObject({ category: 'callback_missed', assignable: false, open: true, leadId: 'L7', companyName: 'Beta GmbH' });
  });

  it('discarded outbound attempts are not listed', () => {
    expect(buildHistory([], [session({ id: 'a', direction: 'outbound', category: 'outbound', status: 'abandoned' })], [])).toHaveLength(0);
  });

  it('a portal call without CRM entry shows its chosen result', () => {
    const [row] = buildHistory([], [session({ id: 'o', direction: 'outbound', category: 'outbound', resultGroup: 'meeting_booked', noteDraft: 'Termin am Di' })], []);
    expect(row).toMatchObject({ resultCode: RESULT_GROUP_CODES.meeting_booked, notePreview: 'Termin am Di' });
  });
});

describe('missed callbacks stay open until called back or done (6.15)', () => {
  const missed = session({ id: 'm1' });

  it('open without later outgoing call', () => {
    const rows = buildHistory([call({ id: 'p0', start: '2026-11-17T08:00:00Z' })], [missed], []);
    expect(rows.find((r) => r.id === 'cs:m1')?.open).toBe(true);
  });

  it('closed by a later outgoing CRM call to the same lead', () => {
    const rows = buildHistory([call({ id: 'p1', start: '2026-11-18T11:00:00Z' })], [missed], []);
    expect(rows.find((r) => r.id === 'cs:m1')?.open).toBe(false);
  });

  it('closed by a later outbound portal session to the same number (other lead record)', () => {
    const back = session({ id: 'b1', leadId: 'L2', direction: 'outbound', category: 'outbound', status: 'completed', dialedAt: T('2026-11-18T12:00:00Z') });
    const rows = buildHistory([], [missed, back], []);
    expect(rows.find((r) => r.id === 'cs:m1')?.open).toBe(false);
  });

  it('closed when marked done', () => {
    const rows = buildHistory([], [{ ...missed, handledAt: T('2026-11-18T09:30:00Z') }], []);
    expect(rows[0]).toMatchObject({ open: false, handled: true });
  });

  it('an earlier outgoing call does not close it', () => {
    expect(
      isMissedOpen({ at: Date.parse('2026-11-18T09:00:00Z'), category: 'callback_missed', leadId: 'L1', e164: null, handled: false }, [
        { at: Date.parse('2026-11-18T08:00:00Z'), leadId: 'L1', e164: null, resultCode: null },
      ]),
    ).toBe(true);
  });
});

describe('filters and search', () => {
  const rows = buildHistory(
    [
      call({ id: 'p1', start: '2026-11-16T08:00:00Z', resultCode: RESULT_GROUP_CODES.not_reached }),
      call({ id: 'p2', start: '2026-11-17T08:00:00Z', leadId: 'L5', leadName: 'Beat Beispiel', companyName: 'Beta GmbH', phoneE164: '+41793334455' }),
    ],
    [session({ id: 'm1' }), session({ id: 'u1', leadId: null, leadName: null, companyName: null, category: 'unknown_number', phoneE164: '+41445550123' })],
    [],
  );

  it('search by name, company and number in any format', () => {
    const s = (q: string) => filterHistory(rows, { search: q }).items.map((r) => r.id);
    expect(s('beta')).toEqual(['pc:p2']);
    expect(s('Anna')).toContain('pc:p1');
    expect(s('079 333 44 55')).toEqual(['pc:p2']);
    expect(s('0041 79 333 44 55')).toEqual(['pc:p2']);
    expect(s('3334455')).toEqual(['pc:p2']);
    expect(s('044 555 01 23')).toEqual(['cs:u1']);
  });

  it('category, day (Zurich), result filters and counts', () => {
    const r = filterHistory(rows, { categories: ['callback_missed'] });
    expect(r.items.map((x) => x.id)).toEqual(['cs:m1']);
    expect(r.counts).toEqual({ outbound: 2, callback_answered: 0, callback_missed: 1, unknown_number: 1 });
    expect(r.openMissed).toBe(1);
    expect(filterHistory(rows, { day: '2026-11-17' }).items.map((x) => x.id)).toEqual(['pc:p2']);
    expect(filterHistory(rows, { resultCodes: [RESULT_GROUP_CODES.not_reached] }).items.map((x) => x.id)).toEqual(['pc:p1']);
    expect(filterHistory(rows, { onlyOpen: true }).items.map((x) => x.id).sort()).toEqual(['cs:m1', 'cs:u1']);
  });

  it('matchesSearch ignores too short digit input', () => {
    expect(matchesSearch({ personName: null, companyName: null, phoneE164: '+41611234567', phoneDisplay: null }, '12')).toBe(false);
  });
});
