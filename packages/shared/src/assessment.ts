/** Parse `kls_ki_bewertung` (multi-line text written by the scoring pipeline) into its first lines (INTENT 6.13). */
import type { LeadAssessment } from './types';

const KEYS: Record<string, keyof Omit<LeadAssessment, 'details' | 'stichworte'> | 'stichworte'> = {
  stand: 'stand',
  grade: 'grade',
  einstieg: 'einstieg',
  stichworte: 'stichworte',
  'nächster schritt': 'naechsterSchritt',
  'naechster schritt': 'naechsterSchritt',
  organisation: 'organisation',
};

export function parseAssessment(text: string | null | undefined): LeadAssessment | null {
  if (!text || !text.trim()) return null;
  const result: LeadAssessment = {
    stand: null,
    grade: null,
    einstieg: null,
    stichworte: [],
    naechsterSchritt: null,
    organisation: null,
    details: [],
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-zÄÖÜäöü ]{3,20}):\s*(.*)$/);
    const key = m ? KEYS[m[1].trim().toLowerCase()] : undefined;
    if (m && key) {
      const value = m[2].trim();
      if (key === 'stichworte') result.stichworte = value.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      else result[key] = value || null;
    } else {
      result.details.push(line);
    }
  }
  return result;
}
