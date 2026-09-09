/**
 * Ordering-target math (V-ordering-targets, Will msg 904): lets staff set
 * their OWN target on-hand balance, by NDC (one product) or by GROUP
 * (cloud/lib/vaccine-group-catalog.ts, e.g. "Flu" covers many NDCs),
 * instead of only ever seeing the auto-recommended target. Pure
 * functions, no Supabase/HTTP — see
 * cloud/app/api/ordering/targets/route.ts for persistence and
 * cloud/app/api/ordering/recommendation/route.ts for how these combine
 * with upcoming7d/onHand per row.
 *
 * Precedence per row: an NDC-scoped override wins outright; otherwise a
 * GROUP-scoped override is apportioned across the group's rows (see
 * apportionGroupTarget); otherwise the row falls back to its own
 * recommendedTarget. `order` always floors at 0 — a target below current
 * on-hand is not a negative order.
 */

import { walkInBuffer } from "@/lib/ordering-recommendation";

/** Same "upcoming + 25%-buffer" shape as computeRecommendedOrder
 * (lib/ordering-recommendation.ts), but as a TARGET balance rather than
 * an order quantity — computeRecommendedOrder(upcoming7d, 0) and
 * recommendedTarget(upcoming7d) are numerically identical; kept as a
 * separate named function because "the target we'd recommend" and "how
 * much on-hand implies right now" are different concepts to callers even
 * though the arithmetic coincides. upcoming7d=0 -> 0 (walkInBuffer(0) is
 * already 0, so no special case needed).
 */
export function recommendedTarget(upcoming7d: number): number {
  return upcoming7d + walkInBuffer(upcoming7d);
}

/**
 * Splits an integer `total` across `weights` (parallel array) using
 * largest-remainder rounding, so the results always sum to EXACTLY
 * `total` (never off by one from plain per-item rounding). When every
 * weight is 0 (a group whose rows all have upcoming7d=0, so every
 * recommendedTarget is 0), splits equally instead of dividing 0/0 —
 * still using largest-remainder so the equal split itself sums exactly.
 * Returns [] for an empty `weights` array (nothing to apportion to).
 */
export function apportionGroupTarget(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];

  const sumWeights = weights.reduce((sum, w) => sum + w, 0);
  const effectiveWeights = sumWeights === 0 ? weights.map(() => 1) : weights;
  const effectiveSum = sumWeights === 0 ? weights.length : sumWeights;

  const raw = effectiveWeights.map((w) => (w / effectiveSum) * total);
  const floors = raw.map(Math.floor);
  const allocated = floors.reduce((sum, f) => sum + f, 0);
  let remainder = total - allocated;

  const order = raw
    .map((value, index) => ({ index, frac: value - floors[index] }))
    .sort((a, b) => b.frac - a.frac);

  const result = [...floors];
  for (let i = 0; i < order.length && remainder > 0; i++, remainder--) {
    result[order[i].index] += 1;
  }
  return result;
}

export type OrderingTargetOverrides = {
  /** digits-only NDC (lib/ndc.ts normalizeNdc) -> target on-hand. */
  ndc: Record<string, number>;
  /** exact vaccine-group display name (lib/vaccine-group-catalog.ts) ->
   * target on-hand. */
  group: Record<string, number>;
};

export type TargetInput = {
  /** Unique per collapsed recommendation row — the row's NDC when it has
   * one, else its vaccine id (lib/ordering-recommendation-ndc.ts's
   * collapse key). */
  key: string;
  ndc: string | null;
  group: string;
  upcoming7d: number;
  onHand: number | null;
};

export type TargetResult = {
  key: string;
  recommendedTarget: number;
  effectiveTarget: number;
  order: number;
  /** Which override (if any) determined effectiveTarget — surfaced so
   * the API/UI can show whether a row's target came from its own NDC
   * override, an apportioned group override, or the plain
   * recommendation. */
  targetSource: "ndc" | "group" | "recommended";
};

/**
 * Computes each row's effective target + order, given the FULL set of
 * rows (so group overrides can be apportioned across every row sharing a
 * group) and the current override set.
 *
 * Apportioning rule (Will's spec): a row WITH its own NDC override is
 * excluded from the group's split, and its target is subtracted from the
 * group's target FIRST (floored at 0) before splitting the remainder
 * across the rows WITHOUT an NDC override, proportional to each row's
 * own recommendedTarget (largest-remainder rounding — see
 * apportionGroupTarget). If every remaining row's recommendedTarget is
 * 0, the remainder splits equally instead.
 */
export function computeEffectiveTargets(rows: TargetInput[], overrides: OrderingTargetOverrides): TargetResult[] {
  const byGroup = new Map<string, TargetInput[]>();
  for (const row of rows) {
    const list = byGroup.get(row.group);
    if (list) list.push(row);
    else byGroup.set(row.group, [row]);
  }

  const apportionedByKey = new Map<string, number>();

  for (const [group, groupRows] of byGroup) {
    const groupTarget = overrides.group[group];
    if (groupTarget === undefined) continue;

    const withNdcOverride = groupRows.filter((row) => row.ndc !== null && overrides.ndc[row.ndc] !== undefined);
    const withoutNdcOverride = groupRows.filter((row) => !(row.ndc !== null && overrides.ndc[row.ndc] !== undefined));
    if (withoutNdcOverride.length === 0) continue;

    const overrideSum = withNdcOverride.reduce((sum, row) => sum + overrides.ndc[row.ndc as string], 0);
    const remaining = Math.max(0, groupTarget - overrideSum);

    const weights = withoutNdcOverride.map((row) => recommendedTarget(row.upcoming7d));
    const apportioned = apportionGroupTarget(remaining, weights);
    withoutNdcOverride.forEach((row, index) => apportionedByKey.set(row.key, apportioned[index]));
  }

  return rows.map((row) => {
    const recommended = recommendedTarget(row.upcoming7d);
    const ndcOverride = row.ndc !== null ? overrides.ndc[row.ndc] : undefined;

    let effective = recommended;
    let targetSource: TargetResult["targetSource"] = "recommended";
    if (ndcOverride !== undefined) {
      effective = ndcOverride;
      targetSource = "ndc";
    } else if (apportionedByKey.has(row.key)) {
      effective = apportionedByKey.get(row.key) as number;
      targetSource = "group";
    }

    return {
      key: row.key,
      recommendedTarget: recommended,
      effectiveTarget: effective,
      order: Math.max(0, effective - (row.onHand ?? 0)),
      targetSource,
    };
  });
}
