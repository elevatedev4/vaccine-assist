import { describe, expect, it } from "vitest";
import { buildToOrderRows, type ToOrderInputRow } from "@/lib/ordering-to-order";

describe("buildToOrderRows", () => {
  it("keeps only rows with order > 0", () => {
    const rows: ToOrderInputRow[] = [
      { key: "a", vaccineName: "Fluad", ndc: "70461012303", group: "Flu", order: 0, active: true },
      { key: "b", vaccineName: "Shingrix", ndc: "58160082311", group: "Other", order: 10, active: true },
    ];
    const result = buildToOrderRows(rows);
    expect(result.map((r) => r.key)).toEqual(["b"]);
  });

  // Reviewer blocking fix (REQUEST_CHANGES on 50a74c8): the API computes
  // `order` for inactive/discontinued products too (it doesn't zero it
  // out), so a low-on-hand inactive product must never surface in "To
  // order" even though its order > 0.
  it("excludes an inactive row even when its order > 0", () => {
    const rows: ToOrderInputRow[] = [
      { key: "active-one", vaccineName: "Shingrix", ndc: "58160082311", group: "Other", order: 5, active: true },
      { key: "inactive-one", vaccineName: "Fluad", ndc: "70461012303", group: "Flu", order: 12, active: false },
    ];
    const result = buildToOrderRows(rows);
    expect(result.map((r) => r.key)).toEqual(["active-one"]);
  });

  it("uses the SAME cleaned display name every other tab shows (season + age stripped)", () => {
    // Real catalog combo: productName "Fluad Trivalent (2026-27)",
    // ageRange "65+" -> formatProductDisplayName produces
    // "Fluad Trivalent (2026-27) (65+)"; lotsDisplayName drops both the
    // redundant season and the age, keeping just "Fluad Trivalent".
    const rows: ToOrderInputRow[] = [
      { key: "a", vaccineName: "Fluad", ndc: "70461012303", group: "Flu", order: 20, active: true },
    ];
    const result = buildToOrderRows(rows);
    expect(result[0].displayName).toBe("Fluad Trivalent");
  });

  it("computes Order (pkg) from the catalog's doses-per-package, ceil-rounded", () => {
    const rows: ToOrderInputRow[] = [
      { key: "a", vaccineName: "Fluad", ndc: "70461012303", group: "Flu", order: 25, active: true },
    ];
    const result = buildToOrderRows(rows);
    expect(result[0].orderPackages).toBe(3); // ceil(25 / 10)
  });

  it("falls back to the researched catalog NDC when the DB row has none on file", () => {
    // "Flucelvax PFS" is seeded with ndc: null but IS in the researched
    // catalog (lib/vaccine-product-catalog.ts).
    const rows: ToOrderInputRow[] = [
      { key: "a", vaccineName: "Flucelvax PFS", ndc: null, group: "Flu", order: 5, active: true },
    ];
    const result = buildToOrderRows(rows);
    expect(result[0].ndc).toBe("70461065603");
  });

  it("returns orderPackages: null when the catalog has no package size for the product", () => {
    const rows: ToOrderInputRow[] = [
      { key: "a", vaccineName: "Some Brand-New Vaccine", ndc: null, group: "Other", order: 8, active: true },
    ];
    const result = buildToOrderRows(rows);
    expect(result[0].orderPackages).toBeNull();
    expect(result[0].order).toBe(8);
  });

  it("groups COVID before Flu before Other, matching the main recommendation table's display order", () => {
    const rows: ToOrderInputRow[] = [
      { key: "other", vaccineName: "Shingrix", ndc: "58160082311", group: "Other", order: 5, active: true },
      { key: "flu", vaccineName: "Fluad", ndc: "70461012303", group: "Flu", order: 5, active: true },
      { key: "covid", vaccineName: "Some Covid Vaccine", ndc: null, group: "COVID", order: 5, active: true },
    ];
    const result = buildToOrderRows(rows);
    expect(result.map((r) => r.key)).toEqual(["covid", "flu", "other"]);
  });

  it("within a group, sorts by order desc then vaccine name asc — same tie-break as the main table", () => {
    const rows: ToOrderInputRow[] = [
      { key: "low-a", vaccineName: "Aaa Vaccine", ndc: null, group: "Other", order: 3, active: true },
      { key: "high", vaccineName: "Zzz Vaccine", ndc: null, group: "Other", order: 10, active: true },
      { key: "low-b", vaccineName: "Bbb Vaccine", ndc: null, group: "Other", order: 3, active: true },
    ];
    const result = buildToOrderRows(rows);
    expect(result.map((r) => r.key)).toEqual(["high", "low-a", "low-b"]);
  });

  it("returns an empty array when nothing needs ordering", () => {
    const rows: ToOrderInputRow[] = [
      { key: "a", vaccineName: "Fluad", ndc: "70461012303", group: "Flu", order: 0, active: true },
    ];
    expect(buildToOrderRows(rows)).toEqual([]);
  });
});
