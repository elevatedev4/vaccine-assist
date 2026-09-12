/**
 * Reorder-quantity math for the Ordering tab (app/api/ordering/recommendation
 * route + desktop's OrderingView). Pure functions, no Supabase/HTTP, so
 * they're easy to unit test — see the route handler for how upcoming7d /
 * onHand are actually computed per vaccine.
 *
 * NOTE: there is no administration-tracking table/endpoint anywhere in
 * this schema — vaccination records live in PioneerRx, not this app (see
 * supabase/migrations/0001_init.sql; there's no "administered" table).
 * Per Will's own spec, this recommendation deliberately has no
 * administered-doses-in-last-7-days input/output field; it's simply
 * omitted rather than faked as 0 or null.
 */

// Walk-in buffer: the store takes walk-ins beyond what's scheduled, so pad
// the upcoming-appointment count before subtracting on-hand stock. 25% of
// upcoming appointments (by default), rounded up, with a minimum buffer
// of 1 dose for any vaccine that has at least one upcoming appointment.
//
// V-T26 item 1 (Will 2026-09-09): this rate is now staff-editable via a
// "Walk-up %" setting on the Ordering screen (persisted server-side —
// see lib/ordering-settings.ts + app/api/ordering/settings/route.ts),
// so every function below takes an optional `rate` override (0-1) that
// the recommendation route passes through as the effective pct/100;
// callers that don't pass one keep getting the original 25% default.
export const WALK_IN_BUFFER_RATE = 0.25;

export function walkInBuffer(upcoming: number, rate: number = WALK_IN_BUFFER_RATE): number {
  if (upcoming <= 0) return 0;
  return Math.max(1, Math.ceil(upcoming * rate));
}

/**
 * recommendedOrder = max(0, upcoming7d + walkInBuffer(upcoming7d, rate) - (onHand ?? 0))
 * `onHand` null (no on-hand data received yet for this vaccine) is
 * treated as 0 — order everything scheduled/buffered, since there's no
 * evidence any stock exists.
 */
export function computeRecommendedOrder(upcoming7d: number, onHand: number | null, rate: number = WALK_IN_BUFFER_RATE): number {
  return Math.max(0, upcoming7d + walkInBuffer(upcoming7d, rate) - (onHand ?? 0));
}

export type RecommendationInput = {
  vaccineId: string;
  vaccineName: string;
  upcoming7d: number;
  onHand: number | null;
  onHandAsOf: string | null;
};

export type RecommendationRow = RecommendationInput & { recommendedOrder: number };

/** Combines the two inputs above into one response row — see the route's
 * RESPONSE CONTRACT doc comment for the exact JSON shape this feeds. */
export function buildRecommendationRow(input: RecommendationInput, rate: number = WALK_IN_BUFFER_RATE): RecommendationRow {
  return { ...input, recommendedOrder: computeRecommendedOrder(input.upcoming7d, input.onHand, rate) };
}

/**
 * Demand model, trend-aware (V-ordering-trend, Will 2026-09-12: "We need
 * our ordering algorithm to be cognizant of how many vaccines we've done
 * in the last week and recommend that we keep up with the trends, since
 * we take walk-ins and not just schedule.").
 *
 * Two competing estimates of "how much of this product will we need in
 * the next 7 days":
 *   - scheduledDemand: the EXISTING schedule-driven estimate — upcoming7d
 *     (booked Acuity appointments) plus its walk-in buffer, numerically
 *     identical to lib/ordering-targets.ts's recommendedTarget().
 *   - trendDemand: given7d itself, no additional buffer — Will's own
 *     framing is that last week's ACTUAL administered-doses pace already
 *     reflects real walk-in volume (a walk-in isn't scheduled, but it
 *     still shows up in what got administered), so buffering it again
 *     would double-count walk-ins.
 *
 * The resulting demandTarget is whichever of the two is larger — a slow
 * week of bookings with a hot walk-in trend still orders enough to keep
 * up, and a heavy-bookings week with no trend history isn't dragged down
 * by an all-zero/undefined given7d (ties, and given7d<=0, fall to
 * "scheduled" — see the tests: this keeps every existing scheduled-only
 * caller's numbers byte-identical when given7d is 0 or omitted).
 */
export type DemandTargetSource = "scheduled" | "trend";

export type DemandTargetResult = {
  given7d: number;
  scheduledDemand: number;
  trendDemand: number;
  /** max(scheduledDemand, trendDemand) — the trend-aware target BEFORE
   * any "Your target" override is applied; callers combine this with
   * their own override precedence (see the recommendation route). */
  demandTarget: number;
  /** Which of the two estimates determined demandTarget. */
  targetSource: DemandTargetSource;
};

export function computeDemandTarget(
  upcoming7d: number,
  given7d: number = 0,
  rate: number = WALK_IN_BUFFER_RATE
): DemandTargetResult {
  const scheduledDemand = upcoming7d + walkInBuffer(upcoming7d, rate);
  const trendDemand = given7d;

  if (trendDemand > scheduledDemand) {
    return { given7d, scheduledDemand, trendDemand, demandTarget: trendDemand, targetSource: "trend" };
  }
  return { given7d, scheduledDemand, trendDemand, demandTarget: scheduledDemand, targetSource: "scheduled" };
}

/**
 * Ordering-page "Surplus" column (Will 2026-09-11): how far BOH sits above
 * or below the row's selected target (its "Your target" override when set,
 * else the recommended target — see the page's `effectiveTarget` field).
 * Returns null (blank cell) when either input is unknown, rather than
 * guessing — onHand null means no on-hand data has arrived yet, and target
 * null means there's nothing to compare against.
 */
export function surplusVsTarget({ onHand, target }: { onHand: number | null; target: number | null }): number | null {
  if (onHand === null || target === null) return null;
  return onHand - target;
}

/** Formats a surplus/deficit for display: a leading "+" for a surplus, a
 * real minus sign (U+2212, not the ASCII hyphen) for a deficit, and a bare
 * "0" when exactly at target. */
export function formatSurplus(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return "0";
}
