/**
 * Shared "is this lot too old to use" rule — Will 2026-09-25 4:58pm
 * verbatim: "if a beyond use date is expired, add the notification on
 * the macro codes as if it were expired fully and stop them from
 * copying the code or continuing data entry without updating it, just
 * like if it were expired." A beyond-use date in the past must block
 * exactly like a past expiration does — same "cannot use this lot until
 * it's updated" behavior in every consumer (macro-codes' copy gate,
 * the desktop data-entry gate), even though the two states get distinct
 * notification text (see lotExpiryState's doc comment).
 *
 * Pure/dependency-free (no React, no Supabase) — same posture as
 * lib/lots-table.ts and lib/lots-row-status.ts, which this module is a
 * SIBLING of, not a replacement for: those two power the /lots page's
 * own "needs attention" highlight (lib/lots-table.ts's isLotRowDue, an
 * INCLUSIVE "expires today counts as due" flag for staff review) and
 * "missing/expired" row status+note (lib/lots-row-status.ts's
 * lotRowStatus, which also folds in a MISSING lot/expiration as its own
 * states). This module instead answers a narrower, STRICTER question —
 * "can this exact lot still be copied/used right now" — for macro-codes'
 * copy gate and the desktop data-entry gate, both of which (like
 * lib/vaccine-entry-payload.ts's existing isLotExpired) treat a lot
 * expiring LATER TODAY as still fine to use: the boundary here is a
 * strict `<`, not lots-table.ts's inclusive `<=`, deliberately matching
 * isLotExpired's existing convention for that same "is it OK to
 * dispense from this lot right now" question rather than lots-table.ts's
 * different "should staff be nudged to update this row" one.
 *
 * Comparison is date-only, on ISO "YYYY-MM-DD" strings — pass
 * lib/chicago-date.ts's todayInChicago() as `today`, never a raw
 * Date/time-of-day value, same convention every other lot-date compare
 * in this codebase (lots-table.ts, lots-row-status.ts,
 * vaccine-entry-payload.ts) uses.
 */

export type LotExpiryLike = {
  expiration?: string | null;
  beyond_use_date?: string | null;
};

export type LotExpiryState = "ok" | "expired" | "bud-expired";

/**
 * 'expired' — `expiration` is set and strictly before `today`. Checked
 *   FIRST or, more precisely, wins over 'bud-expired' when a lot is
 *   somehow both — Will's brief treats "expired" as the more familiar/
 *   primary notion and "beyond-use date passed" as the newer, additional
 *   one, so a lot that's expired on BOTH counts should read as plainly
 *   "expired" rather than surfacing the newer wording.
 * 'bud-expired' — `expiration` is missing OR not yet past, but
 *   `beyond_use_date` is set and strictly before `today`.
 * 'ok' — neither date is set-and-past (a missing/null date never makes
 *   a lot expired on its own — same "don't punish an unresearched field"
 *   posture as lib/vaccine-entry-payload.ts's isLotExpired, which also
 *   treats a null expiration as not-expired).
 */
export function lotExpiryState(lot: LotExpiryLike, today: string): LotExpiryState {
  if (lot.expiration && lot.expiration < today) return "expired";
  if (lot.beyond_use_date && lot.beyond_use_date < today) return "bud-expired";
  return "ok";
}

/**
 * True for either non-'ok' state — the single boolean every gate (macro-
 * codes' copy block, the desktop data-entry gate) actually branches on;
 * the DISTINCT wording ("expired" vs. "beyond-use date passed") is a
 * notification-text concern only, callers get it from lotExpiryState
 * directly when they need to show it.
 */
export function isLotBlocked(lot: LotExpiryLike, today: string): boolean {
  return lotExpiryState(lot, today) !== "ok";
}

export type ModalDatesInput = {
  /** The modal's current Expiration field, "" or "YYYY-MM-DD". */
  expirationIso: string;
  /** The modal's current beyond-use-date field, "" or "YYYY-MM-DD" —
   * ignored entirely (never checked) when `budFieldVisible` is false. */
  beyondUseDateIso: string;
  /** Whether the modal even shows a beyond-use-date field for this row
   * (lib/lots-bud-defaults.ts's isBudFieldVisible) — false means BUD is
   * not this product's concern at all here, same as a row with no BUD
   * column. */
  budFieldVisible: boolean;
  /** Whether this product is in the DEFAULT BUD-enabled set (mNEXSPIKE/
   * Spikevax — lib/lots-bud-defaults.ts's defaultBudEnabledProductKeys).
   * Those products are REQUIRED to carry a beyond-use date — clearing
   * the field must not silently pass this check the way it would for
   * any other product (which may legitimately have no BUD at all). */
  isDefaultBudProduct: boolean;
};

/**
 * Review follow-up (Will, via coordinator, 2026-09-25 evening): the
 * macro-codes "update the lot" modal opened for an expired/bud-expired
 * row was pre-filled with the SAME stale dates and let staff hit Submit
 * with zero edits, still copying the code — isLotBlocked was imported
 * but never actually re-checked against what's IN THE MODAL FORM at
 * submit time. This is that check: true when the dates currently typed
 * into the modal would STILL leave the lot blocked (lib/lot-expiry.ts's
 * isLotBlocked), OR (Will's "stop them from... continuing without
 * updating it" extended to a specific gap) the product is a default-
 * BUD one and its beyond-use-date field is empty — mNEXSPIKE/Spikevax
 * must always carry a real BUD, so clearing it can't read as "not
 * applicable" the way an empty BUD does for every other product.
 *
 * app/macro-codes/page.tsx uses this for BOTH the Submit button's
 * `disabled` and handleModalSubmit's own guard, so the two can never
 * drift (a disabled-but-still-submittable button, or vice versa).
 */
export function modalDatesBlocked(input: ModalDatesInput, today: string): boolean {
  const { expirationIso, beyondUseDateIso, budFieldVisible, isDefaultBudProduct } = input;
  const trimmedBud = beyondUseDateIso.trim();
  if (budFieldVisible && isDefaultBudProduct && trimmedBud.length === 0) return true;
  const effectiveBud = budFieldVisible && trimmedBud.length > 0 ? trimmedBud : null;
  return isLotBlocked({ expiration: expirationIso || null, beyond_use_date: effectiveBud }, today);
}
