import { describe, expect, it } from "vitest";
import { groupByCleanedName, doseCountByVaccineId } from "@/lib/dose-family";
import type { ProductView } from "@/lib/product-view";

function view(overrides: Partial<ProductView>): ProductView {
  return {
    productKey: "name:test",
    vaccineIds: ["v1"],
    active: true,
    displayName: "Test Vaccine",
    ndc: null,
    ndcSource: null,
    packageSize: null,
    group: "Other",
    ...overrides,
  };
}

describe("groupByCleanedName", () => {
  it("groups items sharing a name (trimmed/case-insensitive) together, preserving first-appearance order", () => {
    const groups = groupByCleanedName(
      ["Shingrix", "Comirnaty", "  shingrix  ", "SHINGRIX"],
      (name) => name
    );
    expect(groups).toEqual([["Shingrix", "  shingrix  ", "SHINGRIX"], ["Comirnaty"]]);
  });

  it("returns one group per distinct item when no names repeat", () => {
    const groups = groupByCleanedName(["A", "B", "C"], (name) => name);
    expect(groups).toEqual([["A"], ["B"], ["C"]]);
  });
});

describe("doseCountByVaccineId", () => {
  it("Shingrix regression: two ProductViews split by mismatched NDCs still report the combined family size for every dose id", () => {
    // Reproduces the live bug: upstream grouping (lib/lots-grouping.ts)
    // splits one product's dose rows into separate ProductViews when
    // their NDCs don't match, so each one previously reported
    // vaccineIds.length === 1 instead of the real family size of 2.
    const products: ProductView[] = [
      view({ productKey: "ndc:1", displayName: "Shingrix", vaccineIds: ["s1"] }),
      view({ productKey: "ndc:2", displayName: "Shingrix", vaccineIds: ["s2"] }),
    ];
    const result = doseCountByVaccineId(products);
    expect(result.get("s1")).toBe(2);
    expect(result.get("s2")).toBe(2);
  });

  it("a genuinely single-dose product keeps doseCount 1", () => {
    const products: ProductView[] = [view({ productKey: "ndc:3", displayName: "Comirnaty", vaccineIds: ["c1"] })];
    expect(doseCountByVaccineId(products).get("c1")).toBe(1);
  });

  it("a product with multiple dose ids in ONE ProductView (the normal, unsplit case) sums correctly", () => {
    const products: ProductView[] = [
      view({ productKey: "ndc:4", displayName: "Engerix-B adult 20 mcg", vaccineIds: ["e1", "e2", "e3"] }),
    ];
    expect(doseCountByVaccineId(products).get("e1")).toBe(3);
    expect(doseCountByVaccineId(products).get("e2")).toBe(3);
    expect(doseCountByVaccineId(products).get("e3")).toBe(3);
  });

  it("does not cross-contaminate unrelated products", () => {
    const products: ProductView[] = [
      view({ productKey: "ndc:5", displayName: "Shingrix", vaccineIds: ["s1"] }),
      view({ productKey: "ndc:6", displayName: "Shingrix", vaccineIds: ["s2"] }),
      view({ productKey: "ndc:7", displayName: "Comirnaty", vaccineIds: ["c1"] }),
    ];
    const result = doseCountByVaccineId(products);
    expect(result.get("s1")).toBe(2);
    expect(result.get("s2")).toBe(2);
    expect(result.get("c1")).toBe(1);
  });
});
