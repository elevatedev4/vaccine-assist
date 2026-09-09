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
