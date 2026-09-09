import { describe, expect, it } from "vitest";
import { computeHeadingTotals } from "@/lib/ordering-heading-totals";

describe("computeHeadingTotals", () => {
  it("sums upcoming7d and onHand (treating a null onHand as 0)", () => {
    const totals = computeHeadingTotals([
      { upcoming7d: 3, onHand: 5 },
      { upcoming7d: 2, onHand: null },
      { upcoming7d: 0, onHand: 8 },
    ]);
    expect(totals).toEqual({ upcoming7d: 5, onHand: 13 });
  });

  it("returns {upcoming7d: 0, onHand: 0} for an empty group", () => {
    expect(computeHeadingTotals([])).toEqual({ upcoming7d: 0, onHand: 0 });
  });

  it("the returned object has ONLY upcoming7d/onHand — Recommended target/Your target/Order (doses)/Order (pkg) are never computed for a heading row at all (V-T-ordering-lots-round3: 'leave the target and order all blank')", () => {
    const totals = computeHeadingTotals([{ upcoming7d: 1, onHand: 1 }]);
    expect(Object.keys(totals).sort()).toEqual(["onHand", "upcoming7d"]);
  });
});
