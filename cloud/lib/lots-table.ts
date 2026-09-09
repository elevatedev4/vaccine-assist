/**
 * Pure logic for the rebuilt /lots page (V-cloud-tabs, Will 2026-09-05:
 * "just a table with all the vaccines where you can update the lot /
 * expiration / beyond use date (optional) within the table. The row
 * should highlight if expired or beyond use date is met."). Kept
 * dependency-free of React/Supabase so it's directly unit-testable.
 */

export type LotStatusLike = { status: string; expiration: string };

/**
 * The "current" active lot for a vaccine, among ALL of that vaccine's
 * lots — the one the /lots table's row edits and highlight logic apply
 * to. Earliest-expiration-first (FEFO) among status='active' lots, same
 * tie-break as lib/vaccine-entry-payload.ts's pickActiveUnexpiredLot —
 * but deliberately NOT filtered to unexpired-only like that function is:
 * this page's whole job is to show and let staff fix an expired/BUD-met
 * lot, so an expired active lot must still be the one returned here, not
 * silently skipped.
 */
export function pickCurrentActiveLot<T extends LotStatusLike>(lots: readonly T[]): T | null {
  const active = lots.filter((lot) => lot.status === "active");
  const sorted = [...active].sort((a, b) => (a.expiration < b.expiration ? -1 : a.expiration > b.expiration ? 1 : 0));
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
