import { describe, expect, it } from 'vitest';
import {
  formatPhoneDisplay,
  normalizeForSearch,
  normalizePhone,
  normalizeRecordPhones,
  pickPrimaryPhone,
  samePhone,
  toCrmPhone,
} from './phone';

describe('normalizePhone – Swiss formats', () => {
  const cases: [string, string, string][] = [
    ['+41 61 123 45 67', '+41611234567', '+41 61 123 45 67'],
    ['061 123 45 67', '+41611234567', '+41 61 123 45 67'],
    ['0611234567', '+41611234567', '+41 61 123 45 67'],
    ['0041 61 123 45 67', '+41611234567', '+41 61 123 45 67'],
    ['0041611234567', '+41611234567', '+41 61 123 45 67'],
    ['+41 (0)61 123 45 67', '+41611234567', '+41 61 123 45 67'],
    ['061/123 45 67', '+41611234567', '+41 61 123 45 67'],
    ['061-123-45-67', '+41611234567', '+41 61 123 45 67'],
    ['079 123 45 67', '+41791234567', '+41 79 123 45 67'],
    ['Tel. 044 987 65 43', '+41449876543', '+41 44 987 65 43'],
  ];
  it.each(cases)('%s → %s', (raw, e164, display) => {
    const n = normalizePhone(raw);
    expect(n.status).toBe('ok');
    expect(n.e164).toBe(e164);
    expect(n.display).toBe(display);
    expect(n.country).toBe('CH');
    expect(n.issue).toBeNull();
  });

  it('detects mobile vs fixed', () => {
    expect(normalizePhone('079 123 45 67').type).toBe('mobile');
    expect(normalizePhone('061 123 45 67').type).toBe('fixed');
  });
});

describe('normalizePhone – foreign numbers stay foreign', () => {
  it('keeps +49', () => {
    const n = normalizePhone('+49 7621 123456');
    expect(n.status).toBe('ok');
    expect(n.e164).toBe('+497621123456');
    expect(n.country).toBe('DE');
  });
  it('keeps 0033 as +33', () => {
    const n = normalizePhone('0033 3 89 12 34 56');
    expect(n.status).toBe('ok');
    expect(n.e164).toBe('+33389123456');
    expect(n.country).toBe('FR');
  });
});

describe('normalizePhone – extension', () => {
  it.each([
    ['+41 61 123 45 67 / 212', '212'],
    ['061 123 45 67 ext. 12', '12'],
    ['061 123 45 67 int. 212', '212'],
    ['061 123 45 67 Durchwahl 30', '30'],
    ['061 123 45 67 x 7', '7'],
  ])('%s → ext %s', (raw, ext) => {
    const n = normalizePhone(raw);
    expect(n.status).toBe('ok');
    expect(n.e164).toBe('+41611234567');
    expect(n.extension).toBe(ext);
  });

  it('writes extension to CRM format', () => {
    expect(toCrmPhone(normalizePhone('061 123 45 67 ext. 12'))).toBe('+41 61 123 45 67 ext. 12');
    expect(toCrmPhone(normalizePhone('0611234567'))).toBe('+41 61 123 45 67');
    expect(toCrmPhone(normalizePhone('123'))).toBeNull();
  });
});

describe('normalizePhone – flagged values («Nummer prüfen»)', () => {
  it('empty', () => {
    expect(normalizePhone(null).status).toBe('empty');
    expect(normalizePhone('   ').status).toBe('empty');
    expect(normalizePhone('').issue).toBeNull();
  });
  it('too short', () => {
    const n = normalizePhone('123');
    expect(n.status).toBe('invalid');
    expect(n.e164).toBeNull();
    expect(n.issue).toMatch(/Nummer prüfen/);
  });
  it('invalid Swiss number', () => {
    expect(normalizePhone('061 12 34').status).toBe('invalid');
    expect(normalizePhone('+41 00 000 00 00').status).toBe('invalid');
  });
  it('text', () => {
    expect(normalizePhone('folgt').status).toBe('text');
    expect(normalizePhone('unbekannt').status).toBe('text');
  });
  it('multiple numbers', () => {
    for (const raw of ['061 123 45 67 / 079 765 43 21', '061 123 45 67; 061 765 43 21', '061 123 45 67 oder 079 765 43 21']) {
      const n = normalizePhone(raw);
      expect(n.status, raw).toBe('multiple');
      expect(n.e164).toBeNull();
      expect(n.issue).toMatch(/mehrere Nummern/);
      expect(n.candidates.length).toBe(2);
    }
  });
  it('same number twice is fine', () => {
    expect(normalizePhone('061 123 45 67 / +41 61 123 45 67').status).toBe('ok');
  });
});

describe('helpers', () => {
  it('normalizeForSearch accepts any format', () => {
    expect(normalizeForSearch('0611234567')).toBe('+41611234567');
    expect(normalizeForSearch('+41 61 123 45 67')).toBe('+41611234567');
    expect(normalizeForSearch('abc')).toBeNull();
  });
  it('samePhone ignores format', () => {
    expect(samePhone('061 123 45 67', '+41611234567')).toBe(true);
    expect(samePhone('061 123 45 67', '061 123 45 68')).toBe(false);
    expect(samePhone(null, null)).toBe(false);
  });
  it('formatPhoneDisplay', () => {
    expect(formatPhoneDisplay('+41611234567')).toBe('+41 61 123 45 67');
    expect(formatPhoneDisplay(null)).toBeNull();
  });
  it('normalizeRecordPhones + pickPrimaryPhone', () => {
    const phones = normalizeRecordPhones({ telephone1: 'folgt', mobilephone: '079 123 45 67' });
    expect(phones).toHaveLength(2);
    expect(phones[0].field).toBe('telephone1');
    expect(phones[0].status).toBe('text');
    expect(pickPrimaryPhone(phones)?.e164).toBe('+41791234567');
    expect(pickPrimaryPhone(normalizeRecordPhones({ telephone1: null, mobilephone: '' }))).toBeNull();
  });
});
