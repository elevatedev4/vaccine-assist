import { describe, expect, it } from "vitest";
import {
  buildRecommendationRow,
  computeDemandTarget,
  computeRecommendedOrder,
  formatSurplus,
  surplusVsTarget,
  walkInBuffer,
} from "@/lib/ordering-recommendation";

describe("walkInBuffer", () => {
  it("returns 0 when there are no upcoming appointments", () => {
    expect(walkInBuffer(0)).toBe(0);
  });

  it("returns 0 for a negative upcoming count (defensive)", () => {
    expect(walkInBuffer(-3)).toBe(0);
  });

  it("returns the minimum buffer of 1 for a single upcoming appointment", () => {
    expect(walkInBuffer(1)).toBe(1);
  });

  it("returns the minimum buffer of 1 when 25% rounds below 1", () => {
    expect(walkInBuffer(2)).toBe(1); // 2 * 0.25 = 0.5 -> ceil 1, still floored at min 1
    expect(walkInBuffer(3)).toBe(1); // 3 * 0.25 = 0.75 -> ceil 1
  });

  it("returns 25% rounded up for a larger upcoming count", () => {
    expect(walkInBuffer(4)).toBe(1); // 4 * 0.25 = 1 exactly
    expect(walkInBuffer(5)).toBe(2); // 5 * 0.25 = 1.25 -> ceil 2
    expect(walkInBuffer(20)).toBe(5); // 20 * 0.25 = 5 exactly
    expect(walkInBuffer(21)).toBe(6); // 21 * 0.25 = 5.25 -> ceil 6
  });
});

describe("computeRecommendedOrder", () => {
  it("clamps at 0 when on-hand stock exceeds demand + buffer", () => {
    expect(computeRecommendedOrder(4, 100)).toBe(0);
  });

  it("treats a null on-hand value as 0", () => {
    // upcoming 4, buffer 1 (4*0.25=1), onHand null -> 4 + 1 - 0 = 5
    expect(computeRecommendedOrder(4, null)).toBe(5);
  });

  it("subtracts on-hand stock from demand + buffer", () => {
    // upcoming 20, buffer 5, onHand 8 -> 20 + 5 - 8 = 17
    expect(computeRecommendedOrder(20, 8)).toBe(17);
  });

  it("returns 0 (not negative) with no upcoming demand and no on-hand stock", () => {
    expect(computeRecommendedOrder(0, null)).toBe(0);
    expect(computeRecommendedOrder(0, 0)).toBe(0);
  });
});

describe("buildRecommendationRow", () => {
  it("combines inputs with the computed recommendedOrder", () => {
    const row = buildRecommendationRow({
      vaccineId: "v1",
      vaccineName: "Flu Quad 2025-26",
      upcoming7d: 20,
      onHand: 8,
      onHandAsOf: "2026-08-19T13:00:00.000Z",
    });

    expect(row).toEqual({
      vaccineId: "v1",
      vaccineName: "Flu Quad 2025-26",
      upcoming7d: 20,
      onHand: 8,
      onHandAsOf: "2026-08-19T13:00:00.000Z",
      recommendedOrder: 17,
    });
  });

  it("carries null onHand/onHandAsOf through unchanged", () => {
    const row = buildRecommendationRow({
      vaccineId: "v2",
      vaccineName: "MMR-II",
      upcoming7d: 3,
      onHand: null,
      onHandAsOf: null,
    });

    expect(row.onHand).toBeNull();
    expect(row.onHandAsOf).toBeNull();
    expect(row.recommendedOrder).toBe(4); // 3 + 1 (min buffer) - 0
  });
});

describe("computeDemandTarget", () => {
  it("falls back to scheduledDemand when given7d is omitted (unchanged behaviour)", () => {
    // upcoming7d=20, buffer=5 -> scheduledDemand=25
    const result = computeDemandTarget(20, undefined, 0.25);
    expect(result).toEqual({
      given7d: 0,
      scheduledDemand: 25,
      trendDemand: 0,
      demandTarget: 25,
      targetSource: "scheduled",
    });
  });

  it("falls back to scheduledDemand when given7d is explicitly 0 (unchanged behaviour)", () => {
    const result = computeDemandTarget(4, 0);
    expect(result.demandTarget).toBe(5); // 4 + 1 (min buffer)
    expect(result.targetSource).toBe("scheduled");
  });

  it("picks scheduledDemand on a tie (given7d equal to scheduledDemand)", () => {
    const result = computeDemandTarget(4, 5); // scheduledDemand = 4+1 = 5
    expect(result.demandTarget).toBe(5);
    expect(result.targetSource).toBe("scheduled");
  });

  it("picks trendDemand when last week's actual pace exceeds the scheduled+buffer estimate", () => {
    // upcoming7d=4 -> scheduledDemand=5; given7d=30 (heavy walk-in week) wins.
    const result = computeDemandTarget(4, 30);
    expect(result).toEqual({
      given7d: 30,
      scheduledDemand: 5,
      trendDemand: 30,
      demandTarget: 30,
      targetSource: "trend",
    });
  });

  it("trendDemand is given7d itself, with no additional walk-in buffer applied", () => {
    const result = computeDemandTarget(0, 12);
    expect(result.scheduledDemand).toBe(0);
    expect(result.trendDemand).toBe(12);
    expect(result.demandTarget).toBe(12);
    expect(result.targetSource).toBe("trend");
  });

  it("respects a custom walk-up rate for scheduledDemand", () => {
    // upcoming7d=4, rate=0.5 -> buffer=ceil(4*0.5)=2 -> scheduledDemand=6
    const result = computeDemandTarget(4, 5, 0.5);
    expect(result.scheduledDemand).toBe(6);
    expect(result.targetSource).toBe("scheduled");
  });
});

describe("surplusVsTarget", () => {
  it("returns a positive surplus when on-hand exceeds target", () => {
    expect(surplusVsTarget({ onHand: 20, target: 8 })).toBe(12);
  });

  it("returns a negative deficit when on-hand is below target", () => {
    expect(surplusVsTarget({ onHand: 3, target: 10 })).toBe(-7);
  });

  it("returns 0 when on-hand exactly matches target", () => {
    expect(surplusVsTarget({ onHand: 5, target: 5 })).toBe(0);
  });

  it("returns null when on-hand is unknown", () => {
    expect(surplusVsTarget({ onHand: null, target: 5 })).toBeNull();
  });

  it("returns null when target is unknown", () => {
    expect(surplusVsTarget({ onHand: 5, target: null })).toBeNull();
  });

  it("returns null when both are unknown", () => {
    expect(surplusVsTarget({ onHand: null, target: null })).toBeNull();
  });
});

describe("formatSurplus", () => {
  it("formats a positive surplus with a leading plus", () => {
    expect(formatSurplus(12)).toBe("+12");
  });

  it("formats a deficit with a real minus sign (U+2212)", () => {
    expect(formatSurplus(-3)).toBe("−3");
  });

  it("formats zero as a bare 0", () => {
    expect(formatSurplus(0)).toBe("0");
  });
});
