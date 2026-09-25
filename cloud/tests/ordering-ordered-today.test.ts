import { describe, expect, it } from "vitest";
import { isValidPackagesOrdered, orderedTodayState, remainingPackages } from "@/lib/ordering-ordered-today";

describe("isValidPackagesOrdered", () => {
  it("accepts 0 and positive integers", () => {
    expect(isValidPackagesOrdered(0)).toBe(true);
    expect(isValidPackagesOrdered(5)).toBe(true);
  });

  it("rejects negative numbers, fractions, non-numbers, and non-finite values", () => {
    expect(isValidPackagesOrdered(-1)).toBe(false);
    expect(isValidPackagesOrdered(1.5)).toBe(false);
    expect(isValidPackagesOrdered("3")).toBe(false);
    expect(isValidPackagesOrdered(null)).toBe(false);
    expect(isValidPackagesOrdered(undefined)).toBe(false);
    expect(isValidPackagesOrdered(NaN)).toBe(false);
    expect(isValidPackagesOrdered(Infinity)).toBe(false);
  });
});

describe("remainingPackages", () => {
  it("subtracts orderedToday from orderPackages", () => {
    expect(remainingPackages(5, 2)).toBe(3);
  });

  it("floors at 0 rather than going negative", () => {
    expect(remainingPackages(3, 5)).toBe(0);
    expect(remainingPackages(3, 3)).toBe(0);
  });

  it("returns null when orderPackages itself is unknown (catalog has no package size for this product)", () => {
    expect(remainingPackages(null, 5)).toBeNull();
    expect(remainingPackages(null, 0)).toBeNull();
  });

  it("orderedToday=0 leaves remaining equal to the full recommended package count", () => {
    expect(remainingPackages(4, 0)).toBe(4);
  });
});

describe("orderedTodayState", () => {
  it("is 'none' whenever nothing has been entered today, regardless of orderPackages", () => {
    expect(orderedTodayState({ orderPackages: 5, orderedToday: 0 })).toBe("none");
    expect(orderedTodayState({ orderPackages: null, orderedToday: 0 })).toBe("none");
    expect(orderedTodayState({ orderPackages: 0, orderedToday: 0 })).toBe("none");
  });

  it("is 'partial' once something's entered but it's still below a known, positive orderPackages", () => {
    expect(orderedTodayState({ orderPackages: 3, orderedToday: 1 })).toBe("partial");
    expect(orderedTodayState({ orderPackages: 3, orderedToday: 2 })).toBe("partial");
  });

  it("is 'complete' at the exact edge — orderedToday equal to orderPackages", () => {
    expect(orderedTodayState({ orderPackages: 3, orderedToday: 3 })).toBe("complete");
  });

  it("is 'complete' when orderedToday goes over orderPackages", () => {
    expect(orderedTodayState({ orderPackages: 3, orderedToday: 4 })).toBe("complete");
  });

  it("is 'complete' on any nonzero entry when orderPackages is null (unknown package size) — no numeric target to fall short of", () => {
    expect(orderedTodayState({ orderPackages: null, orderedToday: 1 })).toBe("complete");
    expect(orderedTodayState({ orderPackages: null, orderedToday: 100 })).toBe("complete");
  });

  it("is 'complete' on any nonzero entry when orderPackages is 0 (nothing recommended) — round 2 item 2's 'non-recommended item' case", () => {
    expect(orderedTodayState({ orderPackages: 0, orderedToday: 1 })).toBe("complete");
  });

  it("flips back down when orderedToday is lowered — complete to partial, partial to none", () => {
    expect(orderedTodayState({ orderPackages: 3, orderedToday: 3 })).toBe("complete");
    expect(orderedTodayState({ orderPackages: 3, orderedToday: 2 })).toBe("partial");
    expect(orderedTodayState({ orderPackages: 3, orderedToday: 0 })).toBe("none");
  });
});
