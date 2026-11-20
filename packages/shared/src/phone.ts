/**
 * Phone numbers in one format (INTENT 6.19).
 *
 * - Every number is converted to international format when read: «0…» and «0041…» → +41, foreign numbers (+49, +33 …) stay.
 * - Compare and dial without spaces (`+41611234567`), display readable (`+41 61 123 45 67`).
 * - Extension («Durchwahl») is separated from the main number.
 * - Ambiguous or invalid values (too short, text, several numbers in one field) are flagged → «Nummer prüfen».
 */
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import type { LeadPhone, NormalizedPhone, PhoneField, PhoneType } from './types';

export const DEFAULT_PHONE_REGION: CountryCode = 'CH';

const ISSUE_TEXT = {
  empty: null,
  invalid: 'Nummer prüfen: ungültig oder zu kurz',
  multiple: 'Nummer prüfen: mehrere Nummern im Feld',
  text: 'Nummer prüfen: Text statt Nummer',
} as const;

/** Splits a field into separate number candidates («061 … / 079 …», «…; …», «… oder …»). */
const SPLIT_RE = /\s*(?:;|,|\n|\||\s\/\s|\/(?=\s*(?:\+|0\d))|\s+oder\s+|\s+und\s+|\s+or\s+)\s*/i;
/** Trailing extension: «ext. 12», «int 212», «Durchwahl 30», «DW 30», «x12», «#12». */
const EXT_RE = /\s*(?:ext\.?|extension|int\.?|intern|dw\.?|durchwahl|direktwahl|x|#)\s*:?\s*(\d{1,6})\s*$/i;
/** Leading labels that are harmless. */
const PREFIX_RE = /^(?:tel\.?|telefon|phone|fon|mobile?|natel|handy|zentrale|direkt|geschäft|geschaeft|privat|büro|buero)\s*:?\s*/i;

function digitCount(s: string): number {
  return (s.match(/\d/g) ?? []).length;
}

function emptyResult(raw: string | null, status: NormalizedPhone['status']): NormalizedPhone {
  return {
    raw,
    status,
    e164: null,
    display: null,
    extension: null,
    country: null,
    type: null,
    issue: ISSUE_TEXT[status as keyof typeof ISSUE_TEXT] ?? null,
    candidates: [],
  };
}

function mapType(t: string | undefined): PhoneType | null {
  switch (t) {
    case 'FIXED_LINE':
    case 'FIXED_LINE_OR_MOBILE':
    case 'VOIP':
    case 'UAN':
      return 'fixed';
    case 'MOBILE':
      return 'mobile';
    case 'TOLL_FREE':
      return 'toll_free';
    case undefined:
      return null;
    default:
      return 'other';
  }
}

interface ParsedSingle {
  ok: boolean;
  textOnly: boolean;
  e164: string | null;
  display: string | null;
  extension: string | null;
  country: string | null;
  type: PhoneType | null;
}

function parseSingle(input: string, region: CountryCode): ParsedSingle {
  let s = input.replace(/ /g, ' ').trim();
  s = s.replace(PREFIX_RE, '');
  let extension: string | null = null;
  const ext = s.match(EXT_RE);
  if (ext && digitCount(s.slice(0, ext.index)) >= 7) {
    extension = ext[1];
    s = s.slice(0, ext.index).trim();
  }
  const fail = (textOnly = false): ParsedSingle => ({
    ok: false,
    textOnly,
    e164: null,
    display: null,
    extension,
    country: null,
    type: null,
  });
  if (digitCount(s) === 0) return fail(true);
  // «+41 (0)61 …» → drop the trunk prefix in brackets.
  s = s.replace(/\(\s*0\s*\)/g, '');
  // Letters left over → not a clean number.
  if (/[a-zäöü]/i.test(s)) return fail(digitCount(s) < 7);
  let cleaned = s.replace(/[^\d+]/g, '');
  // Only a leading + is meaningful.
  cleaned = cleaned.replace(/(?!^)\+/g, '');
  if (cleaned.startsWith('00')) cleaned = `+${cleaned.slice(2)}`;
  if (digitCount(cleaned) < 7) return fail();
  const parsed = parsePhoneNumberFromString(cleaned, region);
  if (!parsed || !parsed.isValid()) return fail();
  return {
    ok: true,
    textOnly: false,
    e164: parsed.number,
    display: parsed.formatInternational(),
    extension: extension ?? (parsed.ext ? String(parsed.ext) : null),
    country: parsed.country ?? null,
    type: mapType(parsed.getType()),
  };
}

/**
 * Normalize one CRM phone field.
 * Never throws; check `status` (`ok` → `e164`/`display` set).
 */
export function normalizePhone(raw: string | null | undefined, region: CountryCode = DEFAULT_PHONE_REGION): NormalizedPhone {
  const rawValue = raw ?? null;
  if (raw == null || raw.trim() === '') return emptyResult(rawValue, 'empty');

  const parts = raw.split(SPLIT_RE).map((p) => p.trim()).filter(Boolean);
  const numberParts = parts.filter((p) => digitCount(p) >= 7);
  const shortParts = parts.filter((p) => digitCount(p) > 0 && digitCount(p) < 7);

  if (numberParts.length === 0) {
    const onlyText = parts.every((p) => digitCount(p) === 0) || digitCount(raw) < 3;
    if (onlyText && /[a-zäöü]/i.test(raw)) return emptyResult(rawValue, 'text');
    return emptyResult(rawValue, 'invalid');
  }

  const parsed = numberParts.map((p) => parseSingle(p, region));
  const valid = parsed.filter((p) => p.ok);
  const distinct = [...new Set(valid.map((p) => p.e164 as string))];

  if (numberParts.length > 1) {
    if (distinct.length === 1 && valid.length === numberParts.length) {
      // Same number written twice – harmless.
    } else {
      return { ...emptyResult(rawValue, 'multiple'), candidates: distinct };
    }
  }

  const first = parsed[0];
  if (!first.ok) {
    return emptyResult(rawValue, first.textOnly ? 'text' : 'invalid');
  }

  // «061 123 45 67 / 212» → trailing short part is the extension.
  let extension = first.extension;
  if (!extension && shortParts.length === 1 && /^\d{1,6}$/.test(shortParts[0].replace(/\s/g, ''))) {
    extension = shortParts[0].replace(/\s/g, '');
  } else if (shortParts.length > 0 && !extension) {
    return emptyResult(rawValue, 'invalid');
  }

  return {
    raw: rawValue,
    status: 'ok',
    e164: first.e164,
    display: first.display,
    extension,
    country: first.country,
    type: first.type,
    issue: null,
    candidates: first.e164 ? [first.e164] : [],
  };
}

/** Normalize free user input for the callback search; returns E.164 or null. */
export function normalizeForSearch(input: string | null | undefined, region: CountryCode = DEFAULT_PHONE_REGION): string | null {
  const n = normalizePhone(input, region);
  return n.status === 'ok' ? n.e164 : null;
}

/** Digits only (for suffix matching of partially typed numbers). */
export function phoneDigits(input: string | null | undefined): string {
  return (input ?? '').replace(/\D/g, '');
}

/** National significant number of an E.164 CH number («+41611234567» → «611234567»), used for suffix search. */
export function nationalDigits(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  return parsed ? String(parsed.nationalNumber) : phoneDigits(e164);
}

/** True if both values denote the same number (ignoring format and extension). */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const ea = normalizeForSearch(a);
  const eb = normalizeForSearch(b);
  return ea != null && ea === eb;
}

/** Readable display of an E.164 number; falls back to the input. */
export function formatPhoneDisplay(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const parsed = parsePhoneNumberFromString(e164, DEFAULT_PHONE_REGION);
  return parsed && parsed.isValid() ? parsed.formatInternational() : e164;
}

/** Value to write into the CRM (readable format, open question 11), including extension. */
export function toCrmPhone(phone: NormalizedPhone): string | null {
  if (phone.status !== 'ok' || !phone.display) return null;
  return phone.extension ? `${phone.display} ext. ${phone.extension}` : phone.display;
}

/** Normalize all phone fields of a lead/contact record. Order: telephone1, mobilephone, telephone2, telephone3. */
export function normalizeRecordPhones(record: Partial<Record<PhoneField, string | null>>): LeadPhone[] {
  const fields: PhoneField[] = ['telephone1', 'mobilephone', 'telephone2', 'telephone3'];
  const out: LeadPhone[] = [];
  for (const field of fields) {
    if (!(field in record)) continue;
    const value = record[field];
    if (value == null || value.trim() === '') continue;
    out.push({ ...normalizePhone(value), field });
  }
  return out;
}

/** Best number to dial: first valid fixed line, else first valid mobile; null → «Nummer prüfen». */
export function pickPrimaryPhone(phones: LeadPhone[]): LeadPhone | null {
  const ok = phones.filter((p) => p.status === 'ok');
  return ok.find((p) => p.field === 'telephone1') ?? ok.find((p) => p.type !== 'mobile') ?? ok[0] ?? null;
}

/** True if a record has at least one problematic (non-empty, not ok) number. */
export function hasPhoneIssue(phones: LeadPhone[]): boolean {
  return phones.some((p) => p.status !== 'ok' && p.status !== 'empty');
}
