/**
 * Pure "does this /lots row need a highlight" decision (V-lots-row-
 * status, Will 2026-09-14 verbatim: "If a lot is missing, highlight the
 * row in yellow. If it's expired, highlight it in red. And add a note
 * at the end of the row that shows that status."). Kept dependency-free
 * of React so it's directly unit-testable, same posture as
 * lib/lots-table.ts and lib/lots-autosave.ts.
 *
 * Deliberately its own module rather than an addition to lib/lots-table.ts
 * — that file's isLotRowDue/resolveLotRowHighlight power a DIFFERENT,
 * pre-existing highlight (inclusive of "expires today", no concept of a
 * missing lot at all) that the /lots page no longer uses now that this
 * one covers both cases with the exact semantics of this brief.
 */

export type LotRowStatus = "ok" | "missing" | "expired";

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

/** The set/non-empty ISO dates among expiration + beyond-use date,
 * earliest first — "beyond-use date if set and earlier" per the brief. */
function candidateDates({ expiration, beyondUseDate }: Pick<LotRowStatusInput, "expiration" | "beyondUseDate">): string[] {
  return [expiration, beyondUseDate].filter((d): d is string => !!d && d.length > 0);
}

/**
 * 'missing' — no lot number on file (trimmed empty), regardless of any
 *   date field; a lot can't be expired if there's no lot.
 * 'expired' — a lot number IS on file, and the earlier of
 *   expiration/beyond-use date (whichever are actually set) is strictly
 *   before `today`. A date equal to today is NOT expired (inclusive
 *   "due today" belongs to a different, needs-reordering concept — this
 *   is a flat "is this a bad lot to be dispensing" check).
 * 'ok' — a lot number is on file and no set date is in the past (or no
 *   date is set at all yet).
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
  if (dates.length === 0) return "ok";

  const earliest = dates.reduce((a, b) => (b < a ? b : a));
  return earliest < today ? "expired" : "ok";
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
