/**
 * Pure masking/parsing helpers for DateTextInput (app/date-text-input.tsx)
 * — a typed MM/DD/YYYY text field that replaces every native
 * `<input type="date">` on /lots (Will, 2026-09-09 4:29pm, verbatim:
 * "make it something you can type the whole thing at once and it will
 * automatically add/remove the '/' at the right time, as opposed to
 * being a date picker field ... we'll never use a date picker"). Kept
 * dependency-free of React so it's directly unit-testable.
 *
 * The field stores/reports its value as "YYYY-MM-DD" — the same ISO
 * shape the previous `type="date"` inputs already produced, so every
 * caller's draft state (lot expiration / beyond_use_date) is unchanged.
 */

const NON_DIGIT = /\D/g;

/** Strips every non-digit character. */
export function onlyDigits(value: string): string {
  return value.replace(NON_DIGIT, "");
}

function isPlausibleMonth(mm: number): boolean {
  return mm >= 1 && mm <= 12;
}
function isPlausibleDay(dd: number): boolean {
  return dd >= 1 && dd <= 31;
}

/**
 * Given an exactly-8-digit run typed/pasted in MM DD YYYY order, checks
 * whether it's ALSO plausible read as YYYY MM DD and, if the MM DD YYYY
 * reading is implausible (month>12 or day>31) while the YYYY MM DD
 * reading is plausible, re-groups it into MM DD YYYY order (Will's
 * brief: pasting the unseparated ISO-shaped "20280916" must still land
 * on 09/16/2028, not month "20"). Anything shorter than 8 digits, or an
 * 8-digit run that's already plausible as MM DD YYYY, passes through
 * unchanged — this is deliberately a narrow reinterpretation for one
 * documented shape, not a general "guess the format" parser.
 */
export function reorderIfYyyyMmDd(digits: string): string {
  if (digits.length !== 8) return digits;
  const mm = Number(digits.slice(0, 2));
  const dd = Number(digits.slice(2, 4));
  if (isPlausibleMonth(mm) && isPlausibleDay(dd)) return digits;

  const yyyy = digits.slice(0, 4);
  const mm2 = Number(digits.slice(4, 6));
  const dd2 = Number(digits.slice(6, 8));
  if (Number(yyyy) >= 1000 && isPlausibleMonth(mm2) && isPlausibleDay(dd2)) {
    return `${digits.slice(4, 6)}${digits.slice(6, 8)}${yyyy}`;
  }
  return digits;
}

/** An MM-DD-YYYY-order digit string (1-8 digits, extra digits ignored)
 * -> the progressive "MM/DD/YYYY" display, inserting "/" after the 2nd
 * and 4th digit as they arrive ("0" -> "0", "091" -> "09/1",
 * "09162028" -> "09/16/2028"). */
export function formatDigitsAsMaskedDate(digits: string): string {
  const d = onlyDigits(digits).slice(0, 8);
  const mm = d.slice(0, 2);
  const dd = d.slice(2, 4);
  const yyyy = d.slice(4, 8);
  if (d.length <= 2) return mm;
  if (d.length <= 4) return `${mm}/${dd}`;
  return `${mm}/${dd}/${yyyy}`;
}

/**
 * Single entry point for DateTextInput's onChange (ordinary typing and
 * backspacing, NOT paste — see normalizePastedDateText for that):
 * extracts digits from whatever the field's raw value now is, applies
 * the YYYY-MM-DD reinterpretation once 8 digits have accumulated, and
 * reformats with slashes.
 */
export function maskDateInput(rawValue: string): string {
  const digits = onlyDigits(rawValue).slice(0, 8);
  return formatDigitsAsMaskedDate(reorderIfYyyyMmDd(digits));
}

/** Two-digit-year expansion (Will's brief: "9/16/28" -> 2028) — 00-99
 * maps to 2000-2099; a already-4-digit year passes through unchanged. */
function expandTwoDigitYear(year: string): string {
  if (year.length === 4) return year;
  if (year.length === 2) return `20${year}`;
  return year;
}

/**
 * Parses an explicitly SEPARATED date paste ("09/16/2028", "9/16/28",
 * also accepting "-" or "." as the separator) in month/day/year order
 * into an 8-digit MM DD YYYY digit string, or null if it doesn't match
 * exactly that 3-group shape or the month/day aren't plausible. A
 * pasted string that already states its own grouping via separators
 * needs no YYYY-MM-DD reinterpretation — that ambiguity only exists for
 * an unseparated 8-digit run (see reorderIfYyyyMmDd).
 */
export function parseSeparatedDateText(text: string): string | null {
  const match = text.trim().match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/);
  if (!match) return null;
  const [, mmRaw, ddRaw, yearRaw] = match;
  const mm = Number(mmRaw);
  const dd = Number(ddRaw);
  if (!isPlausibleMonth(mm) || !isPlausibleDay(dd)) return null;
  const yyyy = expandTwoDigitYear(yearRaw);
  return `${mmRaw.padStart(2, "0")}${ddRaw.padStart(2, "0")}${yyyy}`;
}

/**
 * True calendar-date validation (rejects Feb 30, day 32, month 13, ...)
 * — JS Date silently rolls invalid components over into the next
 * month/day rather than rejecting them, so this checks the round-trip
 * instead of trusting `new Date(...)` alone.
 */
export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** "MMDDYYYY" (exactly 8 digits) -> "YYYY-MM-DD" ISO, or null when the
 * digit count is short or the digits don't form a real calendar date
 * (e.g. "02302026" — Feb 30). */
export function digitsToIso(digits: string): string | null {
  if (digits.length !== 8) return null;
  const mm = Number(digits.slice(0, 2));
  const dd = Number(digits.slice(2, 4));
  const yyyy = Number(digits.slice(4, 8));
  if (!isValidCalendarDate(yyyy, mm, dd)) return null;
  return `${digits.slice(4, 8)}-${digits.slice(0, 2)}-${digits.slice(2, 4)}`;
}

/** "YYYY-MM-DD" ISO (as stored today) -> "MM/DD/YYYY" for the field's
 * initial display, or "" for an empty/null/unparseable value. */
export function isoToMaskedDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return "";
  const [, yyyy, mm, dd] = match;
  return `${mm}/${dd}/${yyyy}`;
}

/**
 * Full paste-time normalization (DateTextInput's onPaste): tries the
 * explicitly-separated parse first ("09/16/2028", "9/16/28"), then
 * falls back to the unseparated digit path (including the YYYY-MM-DD
 * reinterpretation) for something like "20280916". Returns the masked
 * "MM/DD/YYYY" display string.
 */
export function normalizePastedDateText(text: string): string {
  const separated = parseSeparatedDateText(text);
  if (separated) return formatDigitsAsMaskedDate(separated);
  return maskDateInput(text);
}
