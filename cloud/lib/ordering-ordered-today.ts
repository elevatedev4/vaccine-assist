/**
 * Ordering "Ordered today" math (V-ordering-ordered-today round 1, Will
 * 2026-09-25 verbatim: "Add a field to the table/recommended order
 * where I can enter the # packages I have ordered for today, they way I
 * can keep track of what I've ordered and know if I need to order more.
 * If something has met the total amount we were supposed to order, you
 * can mark it as 'already ordered full amount' and separate it to the
 * bottom of the recommended order."); orderedTodayState below replaces
 * round 1's isFullyOrdered/splitByOrderedToday per round 2 (same day,
 * verbatim: "Works great. Add the ordered field to the table below too
 * in case we also order other vaccines that weren't on the recomemnded
 * order. Instead of making the item in the recomemdned order move down
 * to its own section, just make it turn green when the full amount has
 * been ordered and yellow if something has been entered and it isn't
 * enough.") — pure functions only, no Supabase/HTTP, so the state math
 * is unit-testable in isolation from both the API (PUT /api/ordering/
 * ordered-today; read back via GET /api/ordering/recommendation's
 * orderedToday/remaining fields, returned for EVERY active row, not
 * just recommended ones) and app/ordering/page.tsx's rendering.
 *
 * Persisted per PRODUCT ROW KEY (the same `key` every other ordering
 * lib uses — digits-only NDC, or "vaccine:<id>" for a no-NDC product)
 * per America/Chicago CALENDAR DAY (lib/chicago-date.ts's
 * todayInChicago) — supabase/migrations/0015_ordering_ordered_today.sql,
 * MIGRATION FILE ONLY per standing convention. A new day has no row yet,
 * so every key implicitly starts back at 0 packages ordered — there is
 * no explicit "reset" step, either here or in the DB.
 *
 * Units: `orderedToday` and `orderPackages` are both PACKAGE counts —
 * the same unit the "To order" table's Order (pkg) column already shows
 * (lib/vaccine-product-catalog.ts's computeOrderPackages), so the two
 * compare directly with no unit conversion here.
 */

/** A valid "packages ordered today" value is a non-negative integer —
 * same shape as every other ordering count in this app (TargetInput's
 * targetOnHand, the Walk-up % setting). */
export function isValidPackagesOrdered(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * recommended packages minus ordered-today packages, floored at 0 —
 * never a negative "remaining" (Will's brief). `orderPackages` is null
 * when the static product catalog (lib/vaccine-product-catalog.ts)
 * doesn't know this product's package size yet (the same case the
 * Order (pkg) column already renders as "—") — remaining is equally
 * unknown in that case, not guessed at.
 */
export function remainingPackages(orderPackages: number | null, orderedToday: number): number | null {
  if (orderPackages === null) return null;
  return Math.max(0, orderPackages - orderedToday);
}

export type OrderedTodayRow = {
  orderPackages: number | null;
  orderedToday: number;
};

/** "none" — nothing entered today, row styling unchanged. "partial" —
 * something's been entered but it's short of a known, positive
 * recommended package count. "complete" — it's met/exceeded that
 * count, OR (round 2 item 2) there's no numeric package target to fall
 * short of in the first place. */
export type OrderedTodayState = "none" | "partial" | "complete";

/**
 * Per-row color state for the "Ordered today" columns (V-ordering-
 * ordered-colors, round 2 — replaces round 1's isFullyOrdered/
 * splitByOrderedToday now that rows stay in place instead of moving to
 * their own section): "just make it turn green when the full amount
 * has been ordered and yellow if something has been entered and it
 * isn't enough."
 *
 * - orderedToday <= 0 → "none": nothing entered, no color change.
 * - orderPackages null or <= 0 → "complete" once orderedToday > 0.
 *   Covers two cases the same way, since both have no numeric target to
 *   fall short of: a product with NO recommendation at all (the "All
 *   vaccines" table's round 2 item 2, verbatim: "in case we also order
 *   other vaccines that weren't on the recomemnded order... where there
 *   is no recommended quantity, a non-zero entry shows green"), and a
 *   recommended row whose static catalog package size just isn't known
 *   yet (orderPackages null despite order > 0 — the "— (N doses)" case
 *   Order qty already renders). Round 1's isFullyOrdered deliberately
 *   never called this case "fully ordered" (nothing to compare against,
 *   so it never left the main list); round 2 removes that list-move
 *   distinction entirely, and coloring a real staff entry green here is
 *   strictly a display choice, not a data change.
 * - Otherwise → "complete" once orderedToday meets or exceeds
 *   orderPackages, else "partial". Lowering orderedToday back below
 *   orderPackages flips this straight back to "partial"/"none" — same
 *   "no separate un-order action needed" reasoning as round 1.
 */
export function orderedTodayState(row: OrderedTodayRow): OrderedTodayState {
  if (row.orderedToday <= 0) return "none";
  if (row.orderPackages === null || row.orderPackages <= 0) return "complete";
  return row.orderedToday >= row.orderPackages ? "complete" : "partial";
}
