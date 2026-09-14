/**
 * Pure "does this /lots row need a highlight" decision (V-lots-row-
 * status, Will 2026-09-14 verbatim: "If a lot is missing, highlight the
 * row in yellow. If it's expired, highlight it in red. And add a note
 * at the end of the row that shows that status."; extended same day,
 * verbatim: "Also needs to show if exp is missing too" — a row with a
 * lot number but no expiration date gets the same pale-yellow highlight
 * as a missing lot, with its own "No expiration" note). Kept
 * dependency-free of React so it's directly unit-testable, same posture
 * as lib/lots-table.ts and lib/lots-autosave.ts.
 *
 * Deliberately its own module rather than an addition to lib/lots-table.ts
 * — that file's isLotRowDue/resolveLotRowHighlight power a DIFFERENT,
 * pre-existing highlight (inclusive of "expires today", no concept of a
 * missing lot at all) that the /lots page no longer uses now that this
 * one covers both cases with the exact semantics of this brief.
 */

import { isValidCalendarDate } from "@/lib/date-mask";

export type LotRowStatus = "ok" | "missing" | "missing-expiration" | "expired";

export type LotRowStatusInput = {
  /** The row's current (draft) lot number — "" or all-whitespace counts
   * as no lot on file. */
  lotNumber: string;
  /** "YYYY-MM-DD", or "" when not set. */
  expiration: string;
  /** "YYYY-MM-DD", "", null, or undefined when not set/not applicable. */
  beyondUseDate?: string | null;
  /** "YYYY-MM-DD" — the pharmacy's local calendar day (pass
   * lib/chicago-date.ts's todayInChicago()), never a raw Date/time-of-day
   * value. */
  today: string;
};

/** Whether `value` (already trimmed) is a real "YYYY-MM-DD" calendar
 * date — rejects both malformed strings and impossible dates like
 * "2026-02-30" (see lib/date-mask.ts's isValidCalendarDate). */
function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, yyyy, mm, dd] = match;
  return isValidCalendarDate(Number(yyyy), Number(mm), Number(dd));
}

/** The set, VALID ISO dates among expiration + beyond-use date, earliest
 * first — "beyond-use date if set and earlier" per the brief. An
 * empty/invalid value in either field is treated as "not set" here, same
 * as isExpirationMissing below, so a garbled date can never accidentally
 * make a row 'expired' via string comparison (e.g. "2026-02-30" sorting
 * before today's date despite not being a real day). */
function candidateDates({ expiration, beyondUseDate }: Pick<LotRowStatusInput, "expiration" | "beyondUseDate">): string[] {
  return [expiration, beyondUseDate].filter((d): d is string => !!d && d.length > 0 && isValidIsoDate(d));
}

/** Whether `expiration` counts as "no expiration on file" — empty after
 * trim, or not a real "YYYY-MM-DD" calendar date. In normal operation
 * DateTextInput's onChange contract only ever hands the page a complete
 * valid ISO date or "" (see app/lots/page.tsx's runAutosave doc comment),
 * so the invalid-date branch is a defensive backstop rather than a
 * reachable UI state today. */
function isExpirationMissing(expiration: string): boolean {
  const trimmed = expiration.trim();
  return trimmed.length === 0 || !isValidIsoDate(trimmed);
}

/**
 * 'missing' — no lot number on file (trimmed empty), regardless of any
 *   date field; a lot can't be expired if there's no lot.
 * 'expired' — a lot number IS on file, and the earlier of
 *   expiration/beyond-use date (whichever are actually set) is strictly
 *   before `today`. A date equal to today is NOT expired (inclusive
 *   "due today" belongs to a different, needs-reordering concept — this
 *   is a flat "is this a bad lot to be dispensing" check).
 * 'missing-expiration' — a lot number IS on file, nothing set date is in
 *   the past (so not 'expired'), but the expiration field itself is
 *   empty/invalid (see isExpirationMissing) — a beyond-use date alone
 *   never satisfies this; it's specifically about the Expiration field.
 * 'ok' — a lot number is on file, no set date is in the past, and an
 *   expiration date IS on file.
 *
 * Precedence within a row (a row is at most one of these):
 *   expired > missing (no lot) > missing-expiration > ok — a lot with no
 *   number never additionally reports "no expiration" too (one message,
 *   "No lot"), and an expired lot is worse than a merely-undated one.
 *
 * Callers must never apply this to an INACTIVE product's row — an
 * inactive product isn't in rotation, so whether its old lot happens to
 * be missing/expired is no longer actionable (same reasoning as
 * lib/lots-table.ts's resolveLotRowHighlight, which the /lots page still
 * applies for the separate grey inactive style).
 */
export function lotRowStatus({ lotNumber, expiration, beyondUseDate, today }: LotRowStatusInput): LotRowStatus {
  if (lotNumber.trim().length === 0) return "missing";

  const dates = candidateDates({ expiration, beyondUseDate });
  if (dates.length > 0) {
    const earliest = dates.reduce((a, b) => (b < a ? b : a));
    if (earliest < today) return "expired";
  }

  if (isExpirationMissing(expiration)) return "missing-expiration";

  return "ok";
}

/**
 * The specific ISO date ("YYYY-MM-DD") that makes a row 'expired' — the
 * earlier of expiration/beyond-use date, whichever is actually set —
 * for display in the row's status-column note ("Expired 06/30/2025").
 * Returns null whenever lotRowStatus(input) isn't 'expired'.
 */
export function lotRowExpiredOn(input: LotRowStatusInput): string | null {
  if (lotRowStatus(input) !== "expired") return null;
  const dates = candidateDates(input);
  return dates.reduce((a, b) => (b < a ? b : a));
}
