/**
 * Pure logic for the rebuilt /lots page (V-cloud-tabs, Will 2026-09-05:
 * "just a table with all the vaccines where you can update the lot /
 * expiration / beyond use date (optional) within the table. The row
 * should highlight if expired or beyond use date is met."). Kept
 * dependency-free of React/Supabase so it's directly unit-testable.
 */

// V-lots-clear-save follow-up (2026-09-16): expiration is nullable —
// clearing ONLY a lot's expiration (leaving its lot_number on file) is a
// real, persisted state now (supabase/migrations/0014_..., "missing
// expiration" needs its own flag per V-lots-row-status, 2026-09-14: "Also
// needs to show if exp is missing too"), unlike clearing lot_number
// (which has no such state — see app/lots/page.tsx's clearCurrentLot).
export type LotStatusLike = { status: string; expiration: string | null };

/** Ascending by expiration, nulls LAST — an unknown expiration is
 * deliberately treated as "expires latest" (least urgent/least
 * preferred), never as sorting ahead of a lot with a real date, so it
 * can never silently jump the FEFO queue. Shared by every "current"/
 * "earliest expiring" lot lookup over lot data (this file's
 * pickCurrentActiveLot below). */
function compareExpirationAscNullsLast(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The "current" active lot for a vaccine, among ALL of that vaccine's
 * lots — the one the /lots table's row edits and highlight logic apply
 * to. Earliest-expiration-first (FEFO, nulls last — see
 * compareExpirationAscNullsLast) among status='active' lots — but
 * deliberately NOT filtered to unexpired/dated-only: this page's whole
 * job is to show and let staff fix an expired, BUD-met, or missing-
 * expiration lot, so that lot must still be the one returned here, not
 * silently skipped.
 */
export function pickCurrentActiveLot<T extends LotStatusLike>(lots: readonly T[]): T | null {
  const active = lots.filter((lot) => lot.status === "active");
  const sorted = [...active].sort((a, b) => compareExpirationAscNullsLast(a.expiration, b.expiration));
  return sorted[0] ?? null;
}

export type LotDueCheck = { expiration?: string | null; beyond_use_date?: string | null };

/**
 * True when the lot's expiration OR beyond-use date is TODAY OR IN THE
 * PAST, compared as "YYYY-MM-DD" strings against `today` (pass
 * lib/chicago-date.ts's todayInChicago() — the pharmacy's fixed
 * America/Chicago calendar day, never a server/browser local zone).
 *
 * Boundary is INCLUSIVE ("today-or-past" per Will's brief) — deliberately
 * different from lib/vaccine-entry-payload.ts's isLotExpired, which uses
 * a strict `<` because that function feeds the data-entry clipboard flow
 * (a lot expiring later today is still fine to use right now). This
 * table is a staff-facing "needs attention" flag instead, where a lot
 * reaching its expiration/BUD today should already read as due.
 */
export function isLotRowDue(lot: LotDueCheck, today: string): boolean {
  if (lot.expiration && lot.expiration <= today) return true;
  if (lot.beyond_use_date && lot.beyond_use_date <= today) return true;
  return false;
}

/**
 * Which highlight a /lots row should get — INACTIVE wins over DUE
 * (review follow-up, cosmetic live bug: an inactive product with an
 * expired lot on file — Afluria MDV/PFS, Priorix, Pfizer 3-4 — was
 * rendering with the red "due" background instead of the grey
 * "inactive" style, making the active/inactive state unclear at a
 * glance). An inactive product isn't in rotation, so whether its old lot
 * happens to be expired is no longer actionable/urgent the way it is for
 * an active product — the grey "this isn't active" signal should always
 * win. "normal" means neither style applies.
 */
export function resolveLotRowHighlight(active: boolean, due: boolean): "inactive" | "due" | "normal" {
  if (!active) return "inactive";
  if (due) return "due";
  return "normal";
}

export type ActiveFlagLike = { active: boolean };

/**
 * V-T21 item 4 (Will, 2026-09-08): splits the /lots page's vaccine list
 * into `active` (shown in the main table, on top) and `inactive` (shown
 * in a collapsed "Inactive vaccines (N)" section below) — order within
 * each group is preserved from the input. Pure/order-stable so the page
 * component just filters twice with a single helper instead of inlining
 * the same predicate in two places.
 */
export function partitionVaccinesByActive<T extends ActiveFlagLike>(
  vaccines: readonly T[]
): { active: T[]; inactive: T[] } {
  const active: T[] = [];
  const inactive: T[] = [];
  for (const vaccine of vaccines) {
    (vaccine.active ? active : inactive).push(vaccine);
  }
  return { active, inactive };
}
