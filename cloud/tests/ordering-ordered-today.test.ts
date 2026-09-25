import { describe, expect, it } from "vitest";
import {
  isFullyOrdered,
  isValidPackagesOrdered,
  remainingPackages,
  splitByOrderedToday,
} from "@/lib/ordering-ordered-today";

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

describe("isFullyOrdered", () => {
  it("is true once orderedToday meets or exceeds a known, positive orderPackages", () => {
    expect(isFullyOrdered(3, 3)).toBe(true);
    expect(isFullyOrdered(3, 4)).toBe(true);
  });

  it("is false while orderedToday is still below orderPackages", () => {
    expect(isFullyOrdered(3, 2)).toBe(false);
    expect(isFullyOrdered(3, 0)).toBe(false);
  });

  it("is false when orderPackages is null (unknown package size) even if orderedToday is large", () => {
    expect(isFullyOrdered(null, 100)).toBe(false);
  });

  it("is false when orderPackages is 0 (nothing recommended) — nothing to compare against, never swept to the bottom on no signal", () => {
    expect(isFullyOrdered(0, 0)).toBe(false);
    expect(isFullyOrdered(0, 5)).toBe(false);
  });

  it("flips back to false when orderedToday is lowered back below orderPackages (rows return to the main list)", () => {
    expect(isFullyOrdered(3, 3)).toBe(true);
    expect(isFullyOrdered(3, 2)).toBe(false);
  });
});

describe("splitByOrderedToday", () => {
  type Row = { key: string; orderPackages: number | null; orderedToday: number };

  it("stable-partitions into remaining vs fullyOrdered, preserving each group's relative order", () => {
    const rows: Row[] = [
      { key: "a", orderPackages: 3, orderedToday: 0 }, // remaining
      { key: "b", orderPackages: 2, orderedToday: 2 }, // fullyOrdered
      { key: "c", orderPackages: 5, orderedToday: 1 }, // remaining
      { key: "d", orderPackages: 1, orderedToday: 1 }, // fullyOrdered
    ];

    const { remaining, fullyOrdered } = splitByOrderedToday(rows);
    expect(remaining.map((r) => r.key)).toEqual(["a", "c"]);
    expect(fullyOrdered.map((r) => r.key)).toEqual(["b", "d"]);
  });

  it("never re-sorts — the caller's own sort order is preserved within each group", () => {
    const rows: Row[] = [
      { key: "z", orderPackages: 10, orderedToday: 0 },
      { key: "a", orderPackages: 10, orderedToday: 0 },
      { key: "m", orderPackages: 10, orderedToday: 0 },
    ];
    const { remaining } = splitByOrderedToday(rows);
    expect(remaining.map((r) => r.key)).toEqual(["z", "a", "m"]);
  });

  it("puts every unknown-package-size row (orderPackages null) into remaining, never fullyOrdered", () => {
    const rows: Row[] = [{ key: "unknown", orderPackages: null, orderedToday: 999 }];
    const { remaining, fullyOrdered } = splitByOrderedToday(rows);
    expect(remaining).toHaveLength(1);
    expect(fullyOrdered).toHaveLength(0);
  });

  it("returns empty arrays for an empty input", () => {
    expect(splitByOrderedToday([])).toEqual({ remaining: [], fullyOrdered: [] });
  });
});
