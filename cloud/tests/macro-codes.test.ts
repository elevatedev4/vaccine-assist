import { describe, expect, it } from "vitest";
import {
  buildMacroCode,
  buildMacroRows,
  expToMacroDate,
  groupMacroRowsForFamily,
  type MacroLotLike,
  type MacroRow,
  type MacroRowVaccine,
} from "@/lib/macro-codes";
import type { ProductView } from "@/lib/product-view";

describe("expToMacroDate", () => {
  it("converts an ISO date to MMDDYYYY", () => {
    expect(expToMacroDate("2027-06-22")).toBe("06222027");
  });

  it("accepts a longer ISO timestamp and uses just its date prefix", () => {
    expect(expToMacroDate("2028-09-29T00:00:00.000Z")).toBe("09292028");
  });

  it("returns '' for null/undefined/empty", () => {
    expect(expToMacroDate(null)).toBe("");
    expect(expToMacroDate(undefined)).toBe("");
    expect(expToMacroDate("")).toBe("");
  });

  it("returns '' for an unparseable value", () => {
    expect(expToMacroDate("not-a-date")).toBe("");
  });
});

describe("buildMacroCode", () => {
  it("single-dose product: no suffix, complete when lot+exp present", () => {
    const result = buildMacroCode({
      shortCode: "comirnaty12",
      doseNumber: 1,
      doseCount: 1,
      lotNumber: "RM3739",
      expirationIso: "2027-06-22",
    });
    expect(result).toEqual({ text: "comirnaty12,RM3739,06222027", complete: true });
  });

  it("multi-dose product: appends the dose number when doseCount > 1", () => {
    const dose1 = buildMacroCode({ shortCode: "shingrix", doseNumber: 1, doseCount: 2, lotNumber: "7C955", expirationIso: "2028-09-29" });
    const dose2 = buildMacroCode({ shortCode: "shingrix", doseNumber: 2, doseCount: 2, lotNumber: "7C955", expirationIso: "2028-09-29" });
    expect(dose1.text).toBe("shingrix1,7C955,09292028");
    expect(dose2.text).toBe("shingrix2,7C955,09292028");
    expect(dose1.complete).toBe(true);
    expect(dose2.complete).toBe(true);
  });

  it("missing lot: text built with a blank lot segment, complete false, no placeholder date invented", () => {
    const result = buildMacroCode({ shortCode: "flucelvaxmdv", doseNumber: 1, doseCount: 1, lotNumber: null, expirationIso: null });
    expect(result).toEqual({ text: "flucelvaxmdv,,", complete: false });
  });

  it("missing exp only: blank exp segment, complete false", () => {
    const result = buildMacroCode({ shortCode: "engerix", doseNumber: 1, doseCount: 3, lotNumber: "2GZ34", expirationIso: null });
    expect(result).toEqual({ text: "engerix1,2GZ34,", complete: false });
  });

  it("missing lot and exp: both segments blank, complete false", () => {
    const result = buildMacroCode({ shortCode: "gardasil", doseNumber: 3, doseCount: 3, lotNumber: "", expirationIso: "" });
    expect(result).toEqual({ text: "gardasil3,,", complete: false });
  });

  it("trims a lot number with surrounding whitespace", () => {
    const result = buildMacroCode({ shortCode: "menveo", doseNumber: 1, doseCount: 1, lotNumber: "  ABC123  ", expirationIso: "2027-01-01" });
    expect(result.text).toBe("menveo,ABC123,01012027");
  });
});

function view(overrides: Partial<ProductView> & { productKey: string; vaccineIds: string[] }): ProductView {
  return {
    displayName: overrides.productKey,
    ndc: null,
    ndcSource: null,
    packageSize: null,
    group: "Other",
    active: true,
    ...overrides,
  };
}

function vaccine(overrides: Partial<MacroRowVaccine> & { id: string }): MacroRowVaccine {
  return {
    name: overrides.id,
    ndc: null,
    dose: "1",
    short_code: "code",
    active: true,
    cash_price_cents: null,
    ...overrides,
  };
}

describe("buildMacroRows", () => {
  it("Shingrix regression: exactly 2 rows for the 2 real seeded dose rows (round-1 bug rendered 4)", () => {
    const products: ProductView[] = [view({ productKey: "ndc:shingrix", displayName: "Shingrix", vaccineIds: ["s1", "s2"] })];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "s1", name: "Shingrix", dose: "1", short_code: "shingrix1" }),
      vaccine({ id: "s2", name: "Shingrix", dose: "2", short_code: "shingrix2" }),
    ];
    const activeLots: Record<string, MacroLotLike[]> = {
      s1: [{ status: "active", expiration: "2028-09-29", lot_number: "7C955" }],
      s2: [{ status: "active", expiration: "2028-09-29", lot_number: "7C955" }],
    };

    const rows = buildMacroRows(products, vaccines, activeLots);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.macro)).toEqual(["shingrix1,7C955,09292028", "shingrix2,7C955,09292028"]);
    expect(rows.map((r) => r.doseNumber)).toEqual([1, 2]);
    expect(rows.every((r) => r.catalogType === "Shingles")).toBe(true);
  });

  it("never synthesizes a dose beyond the real seeded rows, even for a product with no lot data at all", () => {
    const products: ProductView[] = [view({ productKey: "ndc:shingrix", displayName: "Shingrix", vaccineIds: ["s1", "s2"] })];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "s1", name: "Shingrix", dose: "1", short_code: "shingrix1" }),
      vaccine({ id: "s2", name: "Shingrix", dose: "2", short_code: "shingrix2" }),
    ];

    const rows = buildMacroRows(products, vaccines, {});
    expect(rows).toHaveLength(2);
  });

  it("de-dupes duplicate rows sharing the same short_code, preferring the active one with a lot on file", () => {
    const products: ProductView[] = [
      view({ productKey: "ndc:shingrix", displayName: "Shingrix", vaccineIds: ["s1-old", "s1-new", "s2"] }),
    ];
    const vaccines: MacroRowVaccine[] = [
      // A stale duplicate from an NDC transition: same short_code as the
      // real row, inactive, no lot.
      vaccine({ id: "s1-old", name: "Shingrix", dose: "1", short_code: "shingrix1", active: false }),
      vaccine({ id: "s1-new", name: "Shingrix", dose: "1", short_code: "shingrix1", active: true }),
      vaccine({ id: "s2", name: "Shingrix", dose: "2", short_code: "shingrix2" }),
    ];
    const activeLots: Record<string, MacroLotLike[]> = {
      "s1-new": [{ status: "active", expiration: "2028-09-29", lot_number: "7C955" }],
      s2: [{ status: "active", expiration: "2028-09-29", lot_number: "7C955" }],
    };

    const rows = buildMacroRows(products, vaccines, activeLots);
    expect(rows).toHaveLength(2);
    expect(rows[0].macro).toBe("shingrix1,7C955,09292028");
  });

  it("expands a multi-dose product into one row per real dose row, using each row's own short_code AS-IS", () => {
    const products: ProductView[] = [
      view({ productKey: "ndc:engerix", displayName: "Engerix 20 (age 20+)", ndc: "58160082152", packageSize: 10, group: "Other", vaccineIds: ["e1", "e2", "e3"] }),
    ];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "e1", name: "Engerix 20 (age 20+)", dose: "1", short_code: "engerix1" }),
      vaccine({ id: "e2", name: "Engerix 20 (age 20+)", dose: "2", short_code: "engerix2" }),
      vaccine({ id: "e3", name: "Engerix 20 (age 20+)", dose: "3", short_code: "engerix3" }),
    ];
    const activeLots: Record<string, MacroLotLike[]> = {
      e1: [{ status: "active", expiration: "2028-08-14", lot_number: "2GZ34" }],
      e2: [{ status: "active", expiration: "2028-08-14", lot_number: "2GZ34" }],
      e3: [{ status: "active", expiration: "2028-08-14", lot_number: "2GZ34" }],
    };

    const rows = buildMacroRows(products, vaccines, activeLots);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.macro)).toEqual(["engerix1,2GZ34,08142028", "engerix2,2GZ34,08142028", "engerix3,2GZ34,08142028"]);
    expect(rows.every((r) => r.complete)).toBe(true);
    expect(rows.every((r) => r.vaccineIds.length === 3)).toBe(true);
    expect(rows.map((r) => r.doseNumber)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.catalogType === "Hep B (adult)")).toBe(true);
  });

  it("a single-dose product gets exactly one row with no suffix, and carries its cash price", () => {
    const products: ProductView[] = [view({ productKey: "ndc:comirnaty", displayName: "Comirnaty 2025-26 12+", vaccineIds: ["c1"] })];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "c1", name: "Comirnaty 2025-26 12+", dose: "1", short_code: "comirnaty12", cash_price_cents: 14799 }),
    ];
    const activeLots: Record<string, MacroLotLike[]> = { c1: [{ status: "active", expiration: "2027-06-22", lot_number: "RM3739" }] };

    const rows = buildMacroRows(products, vaccines, activeLots);
    expect(rows).toHaveLength(1);
    expect(rows[0].macro).toBe("comirnaty12,RM3739,06222027");
    expect(rows[0].cashPriceCents).toBe(14799);
    expect(rows[0].catalogType).toBe("Pfizer 12+");
    expect(rows[0].family).toBe("fluCovid");
    expect(rows[0].age).toBe("12+");
    expect(rows[0].doseCount).toBe(1);
  });

  it("flags a row incomplete when the vaccine has no active lot on file, without inventing a placeholder date", () => {
    const products: ProductView[] = [view({ productKey: "name:flucelvaxmdv", displayName: "Flucelvax MDV", vaccineIds: ["f1"] })];
    const vaccines: MacroRowVaccine[] = [vaccine({ id: "f1", name: "Flucelvax MDV", dose: "1", short_code: "flucelvaxmdv" })];

    const rows = buildMacroRows(products, vaccines, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].macro).toBe("flucelvaxmdv,,");
    expect(rows[0].complete).toBe(false);
    expect(rows[0].lotNumber).toBeNull();
    expect(rows[0].expirationIso).toBeNull();
  });

  it("excludes inactive products entirely", () => {
    const products: ProductView[] = [
      view({ productKey: "name:active-one", displayName: "Active One", vaccineIds: ["a1"], active: true }),
      view({ productKey: "name:inactive-one", displayName: "Inactive One", vaccineIds: ["i1"], active: false }),
    ];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "a1", name: "Active One", short_code: "activeone" }),
      vaccine({ id: "i1", name: "Inactive One", short_code: "inactiveone", active: false }),
    ];

    const rows = buildMacroRows(products, vaccines, {});
    expect(rows.map((r) => r.productKey)).toEqual(["name:active-one"]);
  });

  it("a product whose vaccine rows carry no short_code at all shows a null shortCode/macro row (no short code set)", () => {
    const products: ProductView[] = [view({ productKey: "name:mystery", displayName: "Mystery Vaccine", vaccineIds: ["m1"] })];
    const vaccines: MacroRowVaccine[] = [vaccine({ id: "m1", name: "Mystery Vaccine", short_code: "" })];

    const rows = buildMacroRows(products, vaccines, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].shortCode).toBeNull();
    expect(rows[0].macro).toBeNull();
    expect(rows[0].complete).toBe(false);
    expect(rows[0].catalogType).toBe("Other");
  });

  it("flucelvaxpfs is family fluCovid with a 6 mo+ age label", () => {
    const products: ProductView[] = [view({ productKey: "name:flucelvaxpfs", displayName: "Flucelvax PFS", vaccineIds: ["f1"] })];
    const vaccines: MacroRowVaccine[] = [vaccine({ id: "f1", name: "Flucelvax PFS", short_code: "flucelvaxpfs" })];

    const rows = buildMacroRows(products, vaccines, {});
    expect(rows[0].family).toBe("fluCovid");
    expect(rows[0].age).toBe("6 mo+");
  });

  it("a multi-dose product's doseCount matches its real deduped dose row count", () => {
    const products: ProductView[] = [view({ productKey: "ndc:gardasil", displayName: "Gardasil", vaccineIds: ["g1", "g2", "g3"] })];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "g1", name: "Gardasil", dose: "1", short_code: "gardasil1" }),
      vaccine({ id: "g2", name: "Gardasil", dose: "2", short_code: "gardasil2" }),
      vaccine({ id: "g3", name: "Gardasil", dose: "3", short_code: "gardasil3" }),
    ];

    const rows = buildMacroRows(products, vaccines, {});
    expect(rows.every((r) => r.doseCount === 3)).toBe(true);
  });

  it("a product with no short code at all gets family 'other', age '', and doseCount 1", () => {
    const products: ProductView[] = [view({ productKey: "name:mystery", displayName: "Mystery Vaccine", vaccineIds: ["m1"] })];
    const vaccines: MacroRowVaccine[] = [vaccine({ id: "m1", name: "Mystery Vaccine", short_code: "" })];

    const rows = buildMacroRows(products, vaccines, {});
    expect(rows[0].family).toBe("other");
    expect(rows[0].age).toBe("");
    expect(rows[0].doseCount).toBe(1);
  });

  it("orders rows by the Excel sheet's row order (sheetOrder), then dose number, then display name", () => {
    const products: ProductView[] = [
      view({ productKey: "name:gardasil", displayName: "Gardasil", vaccineIds: ["g1", "g2"] }),
      view({ productKey: "name:comirnaty", displayName: "Comirnaty 2025-26 12+", vaccineIds: ["c1"] }),
      view({ productKey: "name:mystery", displayName: "Mystery Vaccine", vaccineIds: ["m1"] }),
    ];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "g1", name: "Gardasil", dose: "1", short_code: "gardasil1" }),
      vaccine({ id: "g2", name: "Gardasil", dose: "2", short_code: "gardasil2" }),
      vaccine({ id: "c1", name: "Comirnaty 2025-26 12+", dose: "1", short_code: "comirnaty12" }),
      vaccine({ id: "m1", name: "Mystery Vaccine", short_code: "" }),
    ];

    const rows = buildMacroRows(products, vaccines, {});
    // Comirnaty (sheetOrder 1) before Gardasil (sheetOrder 14) before the
    // no-short-code "Other" row (sorts last); Gardasil's own two doses
    // stay in dose-number order.
    expect(rows.map((r) => r.displayName)).toEqual([
      "Comirnaty 2025-26 12+",
      "Gardasil",
      "Gardasil",
      "Mystery Vaccine",
    ]);
    expect(rows.map((r) => r.doseNumber)).toEqual([1, 1, 2, 1]);
  });
});

describe("groupMacroRowsForFamily", () => {
  it("filters to just the requested family", () => {
    const products: ProductView[] = [
      view({ productKey: "name:comirnaty", displayName: "Comirnaty", vaccineIds: ["c1"] }),
      view({ productKey: "name:gardasil", displayName: "Gardasil", vaccineIds: ["g1"] }),
    ];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "c1", name: "Comirnaty", short_code: "comirnaty12" }),
      vaccine({ id: "g1", name: "Gardasil", short_code: "gardasil1" }),
    ];
    const rows = buildMacroRows(products, vaccines, {});

    expect(groupMacroRowsForFamily(rows, "fluCovid").map((r) => r.displayName)).toEqual(["Comirnaty"]);
    expect(groupMacroRowsForFamily(rows, "other").map((r) => r.displayName)).toEqual(["Gardasil"]);
  });

  it("orders the fluCovid family by ageMinMonths ascending, then type, then product, then dose", () => {
    const products: ProductView[] = [
      view({ productKey: "name:fluad", displayName: "Fluad", vaccineIds: ["fa1"] }),
      view({ productKey: "name:comirnaty", displayName: "Comirnaty", vaccineIds: ["c1"] }),
      view({ productKey: "name:flumist", displayName: "FluMist", vaccineIds: ["fm1"] }),
      view({ productKey: "name:mflusiva", displayName: "mFLUSIVA", vaccineIds: ["mf1"] }),
    ];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "fa1", name: "Fluad", short_code: "fluad" }), // 65+
      vaccine({ id: "c1", name: "Comirnaty", short_code: "comirnaty12" }), // 12+
      vaccine({ id: "fm1", name: "FluMist", short_code: "flumist" }), // 2-49
      vaccine({ id: "mf1", name: "mFLUSIVA", short_code: "mflusiva" }), // 50+
    ];
    const rows = buildMacroRows(products, vaccines, {});

    const grouped = groupMacroRowsForFamily(rows, "fluCovid");
    expect(grouped.map((r) => r.displayName)).toEqual(["FluMist", "Comirnaty", "mFLUSIVA", "Fluad"]);
  });

  it("flags showType/showProduct only on the first row of each Type/product run (HPV combined, not repeated)", () => {
    const products: ProductView[] = [
      view({ productKey: "ndc:gardasil", displayName: "Gardasil", vaccineIds: ["g1", "g2", "g3"] }),
      view({ productKey: "ndc:engerix", displayName: "Engerix 20", vaccineIds: ["e1"] }),
    ];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "g1", name: "Gardasil", dose: "1", short_code: "gardasil1" }),
      vaccine({ id: "g2", name: "Gardasil", dose: "2", short_code: "gardasil2" }),
      vaccine({ id: "g3", name: "Gardasil", dose: "3", short_code: "gardasil3" }),
      vaccine({ id: "e1", name: "Engerix 20", short_code: "engerix1" }),
    ];
    const rows = buildMacroRows(products, vaccines, {});

    const grouped = groupMacroRowsForFamily(rows, "other");
    // sheetOrder: Engerix (10) before Gardasil (14).
    expect(grouped.map((r) => [r.displayName, r.doseNumber, r.showType, r.showProduct])).toEqual([
      ["Engerix 20", 1, true, true],
      ["Gardasil", 1, true, true],
      ["Gardasil", 2, false, false],
      ["Gardasil", 3, false, false],
    ]);
  });

  it("starts a new Type block (and thus a new product) even for a same-named product boundary", () => {
    const products: ProductView[] = [
      view({ productKey: "ndc:mmr", displayName: "MMR-II", vaccineIds: ["m1"] }),
      view({ productKey: "ndc:priorix", displayName: "Priorix", vaccineIds: ["p1"] }),
    ];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "m1", name: "MMR-II", short_code: "mmr1" }),
      vaccine({ id: "p1", name: "Priorix", short_code: "priorix1" }),
    ];
    const rows: MacroRow[] = buildMacroRows(products, vaccines, {});

    const grouped = groupMacroRowsForFamily(rows, "other");
    // Both are catalogType "MMR" but are different products (productKey),
    // so each still gets its own showProduct row even though showType is
    // only true for the first (same Type run).
    expect(grouped.map((r) => [r.displayName, r.showType, r.showProduct])).toEqual([
      ["MMR-II", true, true],
      ["Priorix", false, true],
    ]);
  });
});
