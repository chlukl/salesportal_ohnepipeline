import { describe, expect, it } from 'vitest';
import {
  classifyJobTitle,
  employeeBand,
  gradeFromScore,
  optionLabel,
  OPTION_SETS,
  RESULT_GROUP_CODES,
  resultGroupByCode,
} from './i18n';
import { DEFAULT_RESULT_GROUP_RULES } from './resultGroupDefaults';
import { RESULT_GROUP_KEYS } from './types';

describe('grade', () => {
  it.each([
    [70, 'A'],
    [95, 'A'],
    [69.9, 'B'],
    [50, 'B'],
    [49, 'C'],
    [30, 'C'],
    [29, 'D'],
    [0, 'D'],
    [null, 'unrated'],
    [undefined, 'unrated'],
  ] as const)('%s → %s', (score, grade) => {
    expect(gradeFromScore(score)).toBe(grade);
  });
});

describe('employee bands', () => {
  it.each([
    [null, 'unknown'],
    [0, 'unknown'],
    [3, '1-4'],
    [5, '5-9'],
    [19, '10-19'],
    [20, '20-49'],
    [249, '50-249'],
    [250, '250-999'],
    [1000, '1000+'],
  ] as const)('%s → %s', (n, band) => {
    expect(employeeBand(n)).toBe(band);
  });
});

describe('option sets', () => {
  it('labels known codes and survives unknown ones', () => {
    expect(optionLabel('kls_callstatus', 845140006)).toBe('Termin vereinbart');
    expect(optionLabel('kls_interests', 845140014)).toBe('KI-Dienstleistungen');
    expect(optionLabel('kls_callstatus', 1)).toBe('Wert 1');
    expect(optionLabel('kls_callstatus', null)).toBeNull();
  });
  it('has no ß in labels', () => {
    for (const defs of Object.values(OPTION_SETS)) for (const d of defs) expect(d.label).not.toMatch(/ß/);
  });
  it('maps result groups to unique codes', () => {
    const codes = Object.values(RESULT_GROUP_CODES);
    expect(new Set(codes).size).toBe(15);
    expect(resultGroupByCode(RESULT_GROUP_CODES.callback)).toBe('callback');
  });
});

describe('default result-group rules', () => {
  it('covers all 15 groups exactly once', () => {
    expect(DEFAULT_RESULT_GROUP_RULES.map((r) => r.key).sort()).toEqual([...RESULT_GROUP_KEYS].sort());
  });
  it('every disqualify is preceded by a note (where the group disqualifies unconditionally)', () => {
    for (const rule of DEFAULT_RESULT_GROUP_RULES) {
      const idx = rule.fieldActions.findIndex((a) => a.kind === 'disqualify');
      if (idx >= 0) expect(rule.fieldActions.slice(0, idx).some((a) => a.kind === 'note'), rule.key).toBe(true);
    }
  });
  it('owner/contacted flags: all except not_reached and wrong_number', () => {
    for (const rule of DEFAULT_RESULT_GROUP_RULES) {
      const expected = rule.key !== 'not_reached' && rule.key !== 'wrong_number';
      expect(rule.setsOwnerToCaller, rule.key).toBe(expected);
      expect(rule.setsContacted, rule.key).toBe(expected);
    }
  });
});

describe('classifyJobTitle', () => {
  it.each([
    ['Geschäftsführer', 'management'],
    ['CEO', 'management'],
    ['Leiter Informatik', 'it'],
    ['CFO', 'finance_operations'],
    ['Leiterin Verkauf', 'sales_marketing'],
    ['Produktionsleiter', 'production'],
    ['', 'unknown'],
    ['Assistent', 'other'],
  ] as const)('%s → %s', (title, role) => {
    expect(classifyJobTitle(title)).toBe(role);
  });
});

describe('parseAssessment', async () => {
  const { parseAssessment } = await import('./assessment');
  it('parses the first lines of kls_ki_bewertung', () => {
    const a = parseAssessment('Stand: 01.10.2026 (Score V4)\nGrade: B (58)\nEinstieg: Offerten schneller\nStichworte: Bau, ERP Abacus\nNächster Schritt: Anruf GL\nDetailzeile');
    expect(a?.grade).toBe('B (58)');
    expect(a?.einstieg).toBe('Offerten schneller');
    expect(a?.stichworte).toEqual(['Bau', 'ERP Abacus']);
    expect(a?.naechsterSchritt).toBe('Anruf GL');
    expect(a?.details).toEqual(['Detailzeile']);
    expect(parseAssessment(null)).toBeNull();
  });
});
