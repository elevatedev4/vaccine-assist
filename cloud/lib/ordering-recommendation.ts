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
// upcoming appointments, rounded up, with a minimum buffer of 1 dose for
// any vaccine that has at least one upcoming appointment. Single tunable
// constant, no settings UI in v1.
export const WALK_IN_BUFFER_RATE = 0.25;

export function walkInBuffer(upcoming: number): number {
  if (upcoming <= 0) return 0;
  return Math.max(1, Math.ceil(upcoming * WALK_IN_BUFFER_RATE));
}

/**
 * recommendedOrder = max(0, upcoming7d + walkInBuffer(upcoming7d) - (onHand ?? 0))
 * `onHand` null (no on-hand data received yet for this vaccine) is
 * treated as 0 — order everything scheduled/buffered, since there's no
 * evidence any stock exists.
 */
export function computeRecommendedOrder(upcoming7d: number, onHand: number | null): number {
  return Math.max(0, upcoming7d + walkInBuffer(upcoming7d) - (onHand ?? 0));
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
export function buildRecommendationRow(input: RecommendationInput): RecommendationRow {
  return { ...input, recommendedOrder: computeRecommendedOrder(input.upcoming7d, input.onHand) };
}
