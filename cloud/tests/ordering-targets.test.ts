import { describe, expect, it } from "vitest";
import { apportionGroupTarget, computeEffectiveTargets, recommendedTarget, type TargetInput } from "@/lib/ordering-targets";

describe("recommendedTarget", () => {
  it("returns 0 for zero upcoming demand", () => {
    expect(recommendedTarget(0)).toBe(0);
  });

  it("adds the walk-in buffer (min 1) to upcoming demand", () => {
    expect(recommendedTarget(1)).toBe(2); // 1 + max(1, ceil(0.25)) = 1 + 1
    expect(recommendedTarget(4)).toBe(5); // 4 + 1 (4*0.25=1 exactly)
    expect(recommendedTarget(20)).toBe(25); // 20 + 5 (20*0.25=5 exactly)
  });

  it("matches computeRecommendedOrder(upcoming7d, 0) numerically", () => {
    for (const upcoming of [0, 1, 2, 3, 4, 5, 20, 21]) {
      expect(recommendedTarget(upcoming)).toBeGreaterThanOrEqual(upcoming);
    }
  });
});

describe("apportionGroupTarget", () => {
  it("splits proportionally to weights, summing exactly to the total", () => {
    const result = apportionGroupTarget(10, [1, 1, 1]);
    expect(result.reduce((a, b) => a + b, 0)).toBe(10);
    // 10/3 = 3.33 each -> two get 3, one gets 4 (or similar split) via
    // largest-remainder rounding.
    expect(result.sort()).toEqual([3, 3, 4]);
  });

  it("gives more to a larger weight", () => {
    const result = apportionGroupTarget(100, [1, 3]);
    expect(result[1]).toBeGreaterThan(result[0]);
    expect(result[0] + result[1]).toBe(100);
  });

  it("splits equally (via largest-remainder) when every weight is 0", () => {
    const result = apportionGroupTarget(10, [0, 0, 0]);
    expect(result.reduce((a, b) => a + b, 0)).toBe(10);
    expect(result.sort()).toEqual([3, 3, 4]);
  });

  it("returns [] for an empty weights array", () => {
    expect(apportionGroupTarget(10, [])).toEqual([]);
  });

  it("returns all zeros when total is 0", () => {
    expect(apportionGroupTarget(0, [1, 2, 3])).toEqual([0, 0, 0]);
  });

  it("sums exactly for an odd total across many weights (regression guard for rounding drift)", () => {
    const weights = [1, 2, 3, 4, 5, 6, 7];
    const result = apportionGroupTarget(37, weights);
    expect(result.reduce((a, b) => a + b, 0)).toBe(37);
  });
});

describe("computeEffectiveTargets", () => {
  it("falls back to recommendedTarget when there's no override at all", () => {
    const rows: TargetInput[] = [{ key: "v1", ndc: "111", group: "Flu", upcoming7d: 4, onHand: 1 }];
    const [result] = computeEffectiveTargets(rows, { ndc: {}, group: {} });
    expect(result).toEqual({
      key: "v1",
      recommendedTarget: 5,
      effectiveTarget: 5,
      order: 4, // 5 - 1
      targetSource: "recommended",
    });
  });

  it("an NDC override wins outright, ignoring the recommended target", () => {
    const rows: TargetInput[] = [{ key: "v1", ndc: "111", group: "Flu", upcoming7d: 4, onHand: 1 }];
    const [result] = computeEffectiveTargets(rows, { ndc: { "111": 50 }, group: {} });
    expect(result).toMatchObject({ effectiveTarget: 50, order: 49, targetSource: "ndc" });
  });

  it("apportions a group override across the group's rows, proportional to their recommendedTarget", () => {
    const rows: TargetInput[] = [
      { key: "v1", ndc: "111", group: "Flu", upcoming7d: 20, onHand: 0 }, // recommendedTarget 25
      { key: "v2", ndc: "222", group: "Flu", upcoming7d: 4, onHand: 0 }, // recommendedTarget 5
    ];
    const results = computeEffectiveTargets(rows, { ndc: {}, group: { Flu: 60 } });
    const total = results.reduce((sum, r) => sum + r.effectiveTarget, 0);
    expect(total).toBe(60);
    expect(results.every((r) => r.targetSource === "group")).toBe(true);
    // v1's share (25/30 of 60 = 50) should exceed v2's share (5/30 of 60 = 10).
    const v1 = results.find((r) => r.key === "v1")!;
    const v2 = results.find((r) => r.key === "v2")!;
    expect(v1.effectiveTarget).toBeGreaterThan(v2.effectiveTarget);
  });

  it("a row's own NDC override excludes it from the group split, and its target is subtracted from the group's target first", () => {
    const rows: TargetInput[] = [
      { key: "v1", ndc: "111", group: "Flu", upcoming7d: 20, onHand: 0 }, // NDC override 40
      { key: "v2", ndc: "222", group: "Flu", upcoming7d: 20, onHand: 0 }, // no override, gets the remainder
    ];
    const results = computeEffectiveTargets(rows, { ndc: { "111": 40 }, group: { Flu: 100 } });
    const v1 = results.find((r) => r.key === "v1")!;
    const v2 = results.find((r) => r.key === "v2")!;
    expect(v1).toMatchObject({ effectiveTarget: 40, targetSource: "ndc" });
    // remaining group target = 100 - 40 = 60, entirely to v2 (only row left).
    expect(v2).toMatchObject({ effectiveTarget: 60, targetSource: "group" });
  });

  it("floors the subtracted-override remainder at 0 when the NDC overrides alone exceed the group target", () => {
    const rows: TargetInput[] = [
      { key: "v1", ndc: "111", group: "Flu", upcoming7d: 20, onHand: 0 },
      { key: "v2", ndc: "222", group: "Flu", upcoming7d: 20, onHand: 0 },
    ];
    const results = computeEffectiveTargets(rows, { ndc: { "111": 999 }, group: { Flu: 10 } });
    const v2 = results.find((r) => r.key === "v2")!;
    expect(v2).toMatchObject({ effectiveTarget: 0, targetSource: "group" });
  });

  it("splits a group target equally when every row's recommendedTarget is 0", () => {
    const rows: TargetInput[] = [
      { key: "v1", ndc: "111", group: "Other", upcoming7d: 0, onHand: 0 },
      { key: "v2", ndc: "222", group: "Other", upcoming7d: 0, onHand: 0 },
    ];
    const results = computeEffectiveTargets(rows, { ndc: {}, group: { Other: 10 } });
    const total = results.reduce((sum, r) => sum + r.effectiveTarget, 0);
    expect(total).toBe(10);
    expect(results.map((r) => r.effectiveTarget).sort()).toEqual([5, 5]);
  });

  it("order always floors at 0 even when on-hand exceeds the effective target", () => {
    const rows: TargetInput[] = [{ key: "v1", ndc: null, group: "Other", upcoming7d: 0, onHand: 500 }];
    const [result] = computeEffectiveTargets(rows, { ndc: {}, group: {} });
    expect(result.order).toBe(0);
  });

  it("treats a null onHand as 0 for the order calculation", () => {
    const rows: TargetInput[] = [{ key: "v1", ndc: "111", group: "Flu", upcoming7d: 0, onHand: null }];
    const [result] = computeEffectiveTargets(rows, { ndc: { "111": 10 }, group: {} });
    expect(result.order).toBe(10);
  });

  it("a null-NDC row never receives an NDC override (there's nothing to key it by)", () => {
    const rows: TargetInput[] = [{ key: "vaccine:v1", ndc: null, group: "Other", upcoming7d: 4, onHand: 0 }];
    const [result] = computeEffectiveTargets(rows, { ndc: {}, group: {} });
    expect(result.targetSource).toBe("recommended");
  });

  it("a group override with no matching rows is simply ignored (no crash)", () => {
    const rows: TargetInput[] = [{ key: "v1", ndc: "111", group: "Flu", upcoming7d: 4, onHand: 0 }];
    const results = computeEffectiveTargets(rows, { ndc: {}, group: { COVID: 100 } });
    expect(results[0].targetSource).toBe("recommended");
  });
});
