/**
 * Ordering "Ordered today" math (V-ordering-ordered-today, Will
 * 2026-09-25 verbatim: "Add a field to the table/recommended order
 * where I can enter the # packages I have ordered for today, they way I
 * can keep track of what I've ordered and know if I need to order more.
 * If something has met the total amount we were supposed to order, you
 * can mark it as 'already ordered full amount' and separate it to the
 * bottom of the recommended order.") — pure functions only, no
 * Supabase/HTTP, so the grouping/remaining math is unit-testable in
 * isolation from both the API (PUT /api/ordering/ordered-today; read
 * back via GET /api/ordering/recommendation's orderedToday/remaining
 * fields) and app/ordering/page.tsx's rendering.
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

/**
 * True once today's ordered-today count has met or passed the
 * recommended package count — Will's "already ordered full amount"
 * state. A row with an unknown package size (orderPackages null) or a
 * recommended order of 0 packages (nothing to compare against) can
 * never be "fully ordered" here — it stays in the main list rather than
 * being silently swept to the bottom on no real signal. Lowering
 * orderedToday back below orderPackages flips this back to false — the
 * "rows return to the main list if the value is lowered" rule from
 * Will's brief falls straight out of this being a pure recomputation
 * with no separate "un-order" action needed.
 */
export function isFullyOrdered(orderPackages: number | null, orderedToday: number): boolean {
  return orderPackages !== null && orderPackages > 0 && orderedToday >= orderPackages;
}

export type OrderedTodayRow = {
  orderPackages: number | null;
  orderedToday: number;
};

export type OrderedTodaySplit<T> = {
  /** Rows still needing more ordered today (or of unknown package size)
   * — in the SAME relative order as the input array (a stable
   * partition, not a re-sort): the caller's existing
   * group/order-desc/name-asc sort (lib/ordering-to-order.ts's
   * buildToOrderRows) is preserved exactly, per Will's brief ("Sorting
   * inside each group stays as today"). */
  remaining: T[];
  /** Rows that have met/exceeded their recommended package count today
   * — moved to the bottom, under their own "Already ordered full
   * amount" heading (app/ordering/page.tsx). Same relative order as the
   * input array within this group too. */
  fullyOrdered: T[];
};

/**
 * Stable-partitions `rows` (already sorted by the caller — this never
 * re-sorts) into the still-to-order group and the fully-ordered group,
 * via isFullyOrdered above.
 */
export function splitByOrderedToday<T extends OrderedTodayRow>(rows: readonly T[]): OrderedTodaySplit<T> {
  const remaining: T[] = [];
  const fullyOrdered: T[] = [];
  for (const row of rows) {
    if (isFullyOrdered(row.orderPackages, row.orderedToday)) fullyOrdered.push(row);
    else remaining.push(row);
  }
  return { remaining, fullyOrdered };
}
