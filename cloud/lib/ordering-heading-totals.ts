/**
 * Sums a group's heading-row figures for app/ordering/page.tsx
 * (V-T-ordering-lots-round3, Will 2026-09-09 verbatim: "Leave off the
 * targets for headings. Just leave the target and order all blank on
 * those rows."). Upcoming 7d and On hand are still summed on a heading
 * row; Recommended target, Your target, Order (doses), and Order (pkg)
 * are NOT — this function doesn't even compute them, so the page renders
 * "—" for each of those cells directly rather than deriving (and then
 * discarding) a value. Split out from the page component so it's
 * directly unit-testable without rendering React.
 */

export type HeadingTotalsRow = { upcoming7d: number; onHand: number | null };
export type HeadingTotals = { upcoming7d: number; onHand: number };

export function computeHeadingTotals(rows: readonly HeadingTotalsRow[]): HeadingTotals {
  return rows.reduce<HeadingTotals>(
    (acc, row) => ({ upcoming7d: acc.upcoming7d + row.upcoming7d, onHand: acc.onHand + (row.onHand ?? 0) }),
    { upcoming7d: 0, onHand: 0 }
  );
}
