import { describe, expect, it } from "vitest";
import {
  buildMacroCode,
  buildMacroRows,
  doseButtonShortLabel,
  expToMacroDate,
  filterMacroTopGroups,
  getMacroViewMode,
  groupMacroRowsBySection,
  groupSectionsByTopGroup,
  MACRO_VIEW_MODE,
  macroProductNameWithAge,
  macroSectionDisplayName,
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
    expect(rows[0].section).toBe("COVID");
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

  it("flucelvaxpfs is section Flu with a 6 mo+ age label", () => {
    const products: ProductView[] = [view({ productKey: "name:flucelvaxpfs", displayName: "Flucelvax PFS", vaccineIds: ["f1"] })];
    const vaccines: MacroRowVaccine[] = [vaccine({ id: "f1", name: "Flucelvax PFS", short_code: "flucelvaxpfs" })];

    const rows = buildMacroRows(products, vaccines, {});
    expect(rows[0].section).toBe("Flu");
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

  it("a product with no short code at all gets section 'Other', age '', and doseCount 1", () => {
    const products: ProductView[] = [view({ productKey: "name:mystery", displayName: "Mystery Vaccine", vaccineIds: ["m1"] })];
    const vaccines: MacroRowVaccine[] = [vaccine({ id: "m1", name: "Mystery Vaccine", short_code: "" })];

    const rows = buildMacroRows(products, vaccines, {});
    expect(rows[0].section).toBe("Other");
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

describe("groupMacroRowsBySection", () => {
  it("groups rows into sections, each holding its products", () => {
    const products: ProductView[] = [
      view({ productKey: "name:comirnaty", displayName: "Comirnaty", vaccineIds: ["c1"] }),
      view({ productKey: "name:gardasil", displayName: "Gardasil", vaccineIds: ["g1"] }),
    ];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "c1", name: "Comirnaty", short_code: "comirnaty12" }),
      vaccine({ id: "g1", name: "Gardasil", short_code: "gardasil1" }),
    ];
    const rows = buildMacroRows(products, vaccines, {});

    const sections = groupMacroRowsBySection(rows);
    const covid = sections.find((s) => s.section === "COVID");
    const hpv = sections.find((s) => s.section === "HPV");
    expect(covid?.products.map((p) => p.displayName)).toEqual(["Comirnaty"]);
    expect(hpv?.products.map((p) => p.displayName)).toEqual(["Gardasil"]);
  });

  it("omits a section entirely when it has no products", () => {
    const products: ProductView[] = [view({ productKey: "name:gardasil", displayName: "Gardasil", vaccineIds: ["g1"] })];
    const vaccines: MacroRowVaccine[] = [vaccine({ id: "g1", name: "Gardasil", short_code: "gardasil1" })];
    const rows = buildMacroRows(products, vaccines, {});

    const sections = groupMacroRowsBySection(rows);
    expect(sections.map((s) => s.section)).toEqual(["HPV"]);
  });

  it("orders sections Flu, then COVID, then the rest in sheet order", () => {
    const codes = [
      { code: "gardasil1", name: "Gardasil" }, // HPV
      { code: "shingrix1", name: "Shingrix" }, // Shingles
      { code: "comirnaty12", name: "Comirnaty" }, // COVID
      { code: "flucelvaxmdv", name: "Flucelvax MDV" }, // Flu
      { code: "arexvy", name: "Arexvy" }, // RSV
    ];
    const products: ProductView[] = codes.map(({ code, name }) => view({ productKey: `name:${code}`, displayName: name, vaccineIds: [code] }));
    const vaccines: MacroRowVaccine[] = codes.map(({ code, name }) => vaccine({ id: code, name, short_code: code }));

    const rows = buildMacroRows(products, vaccines, {});
    const sections = groupMacroRowsBySection(rows);
    expect(sections.map((s) => s.section)).toEqual(["Flu", "COVID", "RSV", "Shingles", "HPV"]);
  });

  it("orders products within a section by ageMinMonths, then sheetOrder, then displayName", () => {
    const products: ProductView[] = [
      view({ productKey: "name:fluad", displayName: "Fluad", vaccineIds: ["fa1"] }), // 65+
      view({ productKey: "name:flumist", displayName: "FluMist", vaccineIds: ["fm1"] }), // 2-49
      view({ productKey: "name:flucelvaxmdv", displayName: "Flucelvax MDV", vaccineIds: ["f1"] }), // 6mo+, sheetOrder 4
      view({ productKey: "name:afluriapfs", displayName: "Afluria PFS", vaccineIds: ["af1"] }), // 6mo+, sheetOrder 4
    ];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "fa1", name: "Fluad", short_code: "fluad" }),
      vaccine({ id: "fm1", name: "FluMist", short_code: "flumist" }),
      vaccine({ id: "f1", name: "Flucelvax MDV", short_code: "flucelvaxmdv" }),
      vaccine({ id: "af1", name: "Afluria PFS", short_code: "afluriapfs" }),
    ];
    const rows = buildMacroRows(products, vaccines, {});

    const flu = groupMacroRowsBySection(rows).find((s) => s.section === "Flu");
    // 6mo+ tie broken alphabetically (Afluria PFS before Flucelvax MDV),
    // then 2-49 (FluMist), then 65+ (Fluad).
    expect(flu?.products.map((p) => p.displayName)).toEqual(["Afluria PFS", "Flucelvax MDV", "FluMist", "Fluad"]);
  });

  it("V-T50: a mFLUSIVA row whose short_code doesn't (yet) match the catalog still lands in Flu via its NAME, with the right colorKey", () => {
    const products: ProductView[] = [
      view({ productKey: "name:mflusiva-row", displayName: "mFLUSIVA 2026-27", vaccineIds: ["mf1"] }),
    ];
    const vaccines: MacroRowVaccine[] = [
      // short_code intentionally does NOT match any catalog entry —
      // this is the live-DB gap V-T50's recon found (see
      // scripts/set-vaccine-fields.mjs's new --short-code flag for
      // fixing it at the source).
      vaccine({ id: "mf1", name: "mFLUSIVA 2026-27", short_code: "unmapped123" }),
    ];
    const rows = buildMacroRows(products, vaccines, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].section).toBe("Flu");
    expect(rows[0].colorKey).toBe("mflusiva");

    const sections = groupMacroRowsBySection(rows);
    expect(sections.map((s) => s.section)).toEqual(["Flu"]);
  });

  it("a row with no short_code at all still falls to Other (name fallback never runs off an empty code+unrelated name)", () => {
    const products: ProductView[] = [view({ productKey: "name:mystery-flu", displayName: "Some Future Vaccine", vaccineIds: ["m1"] })];
    const vaccines: MacroRowVaccine[] = [vaccine({ id: "m1", name: "Some Future Vaccine", short_code: "totallyunknown" })];
    const rows = buildMacroRows(products, vaccines, {});
    expect(rows[0].section).toBe("Other");
    expect(rows[0].colorKey).toBe("");
  });

  it("groups a multi-dose product's real dose rows into one product entry with ordered doses", () => {
    const products: ProductView[] = [view({ productKey: "ndc:shingrix", displayName: "Shingrix", vaccineIds: ["s1", "s2"] })];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "s1", name: "Shingrix", dose: "1", short_code: "shingrix1" }),
      vaccine({ id: "s2", name: "Shingrix", dose: "2", short_code: "shingrix2" }),
    ];
    const rows = buildMacroRows(products, vaccines, {});

    const shingles = groupMacroRowsBySection(rows).find((s) => s.section === "Shingles");
    expect(shingles?.products).toHaveLength(1);
    const product = shingles!.products[0];
    expect(product.doses).toHaveLength(2);
    expect(product.doses.map((d) => d.row.doseNumber)).toEqual([1, 2]);
  });

  it("keeps two different products of the same catalogType (e.g. MMR-II/Priorix) as two separate product entries", () => {
    const products: ProductView[] = [
      view({ productKey: "ndc:mmr", displayName: "MMR-II", vaccineIds: ["m1"] }),
      view({ productKey: "ndc:priorix", displayName: "Priorix", vaccineIds: ["p1"] }),
    ];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "m1", name: "MMR-II", short_code: "mmr1" }),
      vaccine({ id: "p1", name: "Priorix", short_code: "priorix1" }),
    ];
    const rows: MacroRow[] = buildMacroRows(products, vaccines, {});

    const mmr = groupMacroRowsBySection(rows).find((s) => s.section === "MMR");
    expect(mmr?.products.map((p) => p.displayName)).toEqual(["MMR-II", "Priorix"]);
  });

  it("carries the product's age and cash price onto the product group (not per dose)", () => {
    const products: ProductView[] = [view({ productKey: "name:comirnaty", displayName: "Comirnaty", vaccineIds: ["c1"] })];
    const vaccines: MacroRowVaccine[] = [vaccine({ id: "c1", name: "Comirnaty", short_code: "comirnaty12", cash_price_cents: 14799 })];
    const rows = buildMacroRows(products, vaccines, {});

    const product = groupMacroRowsBySection(rows).find((s) => s.section === "COVID")!.products[0];
    expect(product.age).toBe("12+");
    expect(product.cashPriceCents).toBe(14799);
  });

  describe("ROUND 9: ageBase / note propagate from the catalog onto MacroRow and MacroProductGroup", () => {
    it("Shingrix: ageBase '50+', note '19+ if immunocompromised', full `age` untouched", () => {
      const products: ProductView[] = [view({ productKey: "ndc:shingrix", displayName: "Shingrix", vaccineIds: ["s1", "s2"] })];
      const vaccines: MacroRowVaccine[] = [
        vaccine({ id: "s1", name: "Shingrix", dose: "1", short_code: "shingrix1" }),
        vaccine({ id: "s2", name: "Shingrix", dose: "2", short_code: "shingrix2" }),
      ];
      const rows = buildMacroRows(products, vaccines, {});
      expect(rows.every((r) => r.age === "50+ (19+ IC)")).toBe(true);
      expect(rows.every((r) => r.ageBase === "50+")).toBe(true);
      expect(rows.every((r) => r.note === "19+ if immunocompromised")).toBe(true);

      const product = groupMacroRowsBySection(rows).find((s) => s.section === "Shingles")!.products[0];
      expect(product.ageBase).toBe("50+");
      expect(product.note).toBe("19+ if immunocompromised");
    });

    it("a product with no catalog qualifier (Comirnaty) has ageBase equal to age and no note", () => {
      const products: ProductView[] = [view({ productKey: "name:comirnaty", displayName: "Comirnaty", vaccineIds: ["c1"] })];
      const vaccines: MacroRowVaccine[] = [vaccine({ id: "c1", name: "Comirnaty", short_code: "comirnaty12" })];
      const rows = buildMacroRows(products, vaccines, {});

      const product = groupMacroRowsBySection(rows).find((s) => s.section === "COVID")!.products[0];
      expect(product.ageBase).toBe("12+");
      expect(product.note).toBeUndefined();
    });

    it("a product with no short code (Other/MACRO_CATALOG_OTHER) has an empty ageBase and no note", () => {
      const products: ProductView[] = [view({ productKey: "name:mystery", displayName: "Mystery Vaccine", vaccineIds: ["m1"] })];
      const vaccines: MacroRowVaccine[] = [vaccine({ id: "m1", name: "Mystery Vaccine", short_code: "" })];
      const rows = buildMacroRows(products, vaccines, {});
      expect(rows[0].ageBase).toBe("");
      expect(rows[0].note).toBeUndefined();
    });
  });

  describe("ROUND 10: doseInterval propagates from the catalog's doseSchedule onto MacroRow", () => {
    it("Shingrix: dose 1 undefined, dose 2 '2 mo'", () => {
      const products: ProductView[] = [view({ productKey: "ndc:shingrix", displayName: "Shingrix", vaccineIds: ["s1", "s2"] })];
      const vaccines: MacroRowVaccine[] = [
        vaccine({ id: "s1", name: "Shingrix", dose: "1", short_code: "shingrix1" }),
        vaccine({ id: "s2", name: "Shingrix", dose: "2", short_code: "shingrix2" }),
      ];
      const rows = buildMacroRows(products, vaccines, {});
      const dose1 = rows.find((r) => r.doseNumber === 1)!;
      const dose2 = rows.find((r) => r.doseNumber === 2)!;
      expect(dose1.doseInterval).toBeUndefined();
      expect(dose2.doseInterval).toBe("2 mo");
    });

    it("a single-dose product (Boostrix) never gets a doseInterval, even though it has no doseSchedule to begin with", () => {
      const products: ProductView[] = [view({ productKey: "name:boostrix", displayName: "Boostrix", vaccineIds: ["b1"] })];
      const vaccines: MacroRowVaccine[] = [vaccine({ id: "b1", name: "Boostrix", short_code: "boostrix1" })];
      const rows = buildMacroRows(products, vaccines, {});
      expect(rows[0].doseCount).toBe(1);
      expect(rows[0].doseInterval).toBeUndefined();
    });

    it("Gardasil 9: dose 3 carries the '15+' interval text (shortened round-10-fix)", () => {
      const products: ProductView[] = [
        view({ productKey: "ndc:gardasil", displayName: "Gardasil 9", vaccineIds: ["g1", "g2", "g3"] }),
      ];
      const vaccines: MacroRowVaccine[] = [
        vaccine({ id: "g1", name: "Gardasil 9", dose: "1", short_code: "gardasil1" }),
        vaccine({ id: "g2", name: "Gardasil 9", dose: "2", short_code: "gardasil2" }),
        vaccine({ id: "g3", name: "Gardasil 9", dose: "3", short_code: "gardasil3" }),
      ];
      const rows = buildMacroRows(products, vaccines, {});
      const dose3 = rows.find((r) => r.doseNumber === 3)!;
      expect(dose3.doseInterval).toBe("6 mo (15+)");
    });

    it("a product with no short code (Other) has an undefined doseInterval", () => {
      const products: ProductView[] = [view({ productKey: "name:mystery", displayName: "Mystery Vaccine", vaccineIds: ["m1"] })];
      const vaccines: MacroRowVaccine[] = [vaccine({ id: "m1", name: "Mystery Vaccine", short_code: "" })];
      const rows = buildMacroRows(products, vaccines, {});
      expect(rows[0].doseInterval).toBeUndefined();
    });
  });

  describe("ROUND 10: doseButtonShortLabel", () => {
    it("returns 'One dose' for a single-dose product (doseCount 1), regardless of dose number", () => {
      const row = { doseNumber: 1 } as MacroRow;
      expect(doseButtonShortLabel(row, 1)).toBe("One dose");
    });

    it("returns 'Dose N' for a multi-dose product", () => {
      expect(doseButtonShortLabel({ doseNumber: 1 } as MacroRow, 2)).toBe("Dose 1");
      expect(doseButtonShortLabel({ doseNumber: 2 } as MacroRow, 2)).toBe("Dose 2");
      expect(doseButtonShortLabel({ doseNumber: 3 } as MacroRow, 3)).toBe("Dose 3");
    });
  });

  describe("dose button labels", () => {
    it("single-dose non-COVID product: display name plus its catalog age in parens", () => {
      const products: ProductView[] = [view({ productKey: "name:abrysvo", displayName: "Abrysvo", vaccineIds: ["a1"] })];
      const vaccines: MacroRowVaccine[] = [vaccine({ id: "a1", name: "Abrysvo", short_code: "abrysvo" })];
      const rows = buildMacroRows(products, vaccines, {});

      const product = groupMacroRowsBySection(rows).find((s) => s.section === "RSV")!.products[0];
      // V-macro-codes-round9: Abrysvo's age is now "75+ (18+ high-risk)"
      // (was "60+ / preg 32–36 wk") — its trailing parenthetical gets
      // flattened to a comma clause like Shingrix's, unlike the old age
      // string which had no parens to flatten.
      expect(product.doses.map((d) => d.label)).toEqual(["Abrysvo (75+, 18+ high-risk)"]);
    });

    it("single-dose COVID products: display name plus the catalog age in parens", () => {
      const products: ProductView[] = [
        view({ productKey: "name:comirnaty", displayName: "Comirnaty", vaccineIds: ["c1"] }),
        view({ productKey: "name:mnexspike", displayName: "mNEXSPIKE", vaccineIds: ["mn1"] }),
        view({ productKey: "name:spikevax", displayName: "Spikevax", vaccineIds: ["sp1"] }),
      ];
      const vaccines: MacroRowVaccine[] = [
        vaccine({ id: "c1", name: "Comirnaty", short_code: "comirnaty12" }),
        vaccine({ id: "mn1", name: "mNEXSPIKE", short_code: "mnexspike" }),
        vaccine({ id: "sp1", name: "Spikevax", short_code: "spikevax6mo11" }),
      ];
      const rows = buildMacroRows(products, vaccines, {});

      const covid = groupMacroRowsBySection(rows).find((s) => s.section === "COVID")!;
      const labelsByName = Object.fromEntries(covid.products.map((p) => [p.displayName, p.doses.map((d) => d.label)]));
      // V-T (Will 2026-09-24): dose button labels run the product's
      // displayName through lib/vaccine-display-name.ts's
      // vaccineDisplayName, which prefixes every COVID vaccine with its
      // manufacturer — MacroProductGroup.displayName itself (the map's
      // OWN keys here) is untouched, matching-only.
      expect(labelsByName["Comirnaty"]).toEqual(["Pfizer Comirnaty (12+)"]);
      expect(labelsByName["mNEXSPIKE"]).toEqual(["Moderna mNEXSPIKE (12+)"]);
      expect(labelsByName["Spikevax"]).toEqual(["Moderna Spikevax (3–11)"]);
    });

    it("multi-dose non-COVID product: display name plus '(Dose N)', plus the age in parens (flattening the age's own parens to a comma)", () => {
      const products: ProductView[] = [view({ productKey: "ndc:shingrix", displayName: "Shingrix", vaccineIds: ["s1", "s2"] })];
      const vaccines: MacroRowVaccine[] = [
        vaccine({ id: "s1", name: "Shingrix", dose: "1", short_code: "shingrix1" }),
        vaccine({ id: "s2", name: "Shingrix", dose: "2", short_code: "shingrix2" }),
      ];
      const rows = buildMacroRows(products, vaccines, {});

      const product = groupMacroRowsBySection(rows).find((s) => s.section === "Shingles")!.products[0];
      expect(product.doses.map((d) => d.label)).toEqual(["Shingrix (Dose 1) (50+, 19+ IC)", "Shingrix (Dose 2) (50+, 19+ IC)"]);
    });

    it("Shingrix regression: two doses split into separate ProductViews upstream still number 1/2, not two identical buttons", () => {
      // Reproduces the live bug: upstream product grouping (keyed by the
      // raw vaccine row's NDC) put Shingrix's two dose rows into TWO
      // separate ProductViews instead of one product with two doses.
      const products: ProductView[] = [
        view({ productKey: "ndc:shingrix-dose1", displayName: "Shingrix", vaccineIds: ["s1"] }),
        view({ productKey: "ndc:shingrix-dose2", displayName: "Shingrix", vaccineIds: ["s2"] }),
      ];
      const vaccines: MacroRowVaccine[] = [
        vaccine({ id: "s1", name: "Shingrix", dose: "1", short_code: "shingrix1" }),
        vaccine({ id: "s2", name: "Shingrix", dose: "2", short_code: "shingrix2" }),
      ];
      const rows = buildMacroRows(products, vaccines, {});

      const product = groupMacroRowsBySection(rows).find((s) => s.section === "Shingles")!.products[0];
      expect(product.doses.map((d) => d.label)).toEqual(["Shingrix (Dose 1) (50+, 19+ IC)", "Shingrix (Dose 2) (50+, 19+ IC)"]);
    });

    it("a product with no short code gets its plain display name as the (unclickable) label", () => {
      const products: ProductView[] = [view({ productKey: "name:mystery", displayName: "Mystery Vaccine", vaccineIds: ["m1"] })];
      const vaccines: MacroRowVaccine[] = [vaccine({ id: "m1", name: "Mystery Vaccine", short_code: "" })];
      const rows = buildMacroRows(products, vaccines, {});

      const product = groupMacroRowsBySection(rows).find((s) => s.section === "Other")!.products[0];
      expect(product.doses.map((d) => d.label)).toEqual(["Mystery Vaccine"]);
      expect(product.doses[0].row.shortCode).toBeNull();
    });

    it("Engerix-B's macro-page name is 'Engerix-B adult' (dropping '20 mcg'), independent of the shared /lots name", () => {
      const products: ProductView[] = [
        view({ productKey: "ndc:engerix", displayName: "Engerix-B adult 20 mcg", vaccineIds: ["e1"] }),
      ];
      const vaccines: MacroRowVaccine[] = [vaccine({ id: "e1", name: "Engerix-B adult 20 mcg", short_code: "engerix1" })];
      const rows = buildMacroRows(products, vaccines, {});

      const product = groupMacroRowsBySection(rows).find((s) => s.section === "Hep B")!.products[0];
      expect(product.displayName).toBe("Engerix-B adult");
      expect(product.doses.map((d) => d.label)).toEqual(["Engerix-B adult (20+)"]);
    });
  });
});

describe("groupSectionsByTopGroup", () => {
  function rowsFor(codes: { code: string; name: string }[]): MacroRow[] {
    const products: ProductView[] = codes.map(({ code, name }) => view({ productKey: `name:${code}`, displayName: name, vaccineIds: [code] }));
    const vaccines: MacroRowVaccine[] = codes.map(({ code, name }) => vaccine({ id: code, name, short_code: code }));
    return buildMacroRows(products, vaccines, {});
  }

  it("groups Flu and COVID into 'COVID/Flu', Pneumonia/RSV/Shingles/Tetanus/HPV into 'Common', and the rest into 'Other'", () => {
    const rows = rowsFor([
      { code: "flucelvaxmdv", name: "Flucelvax MDV" }, // Flu
      { code: "comirnaty12", name: "Comirnaty" }, // COVID
      { code: "prevnar20", name: "Prevnar 20" }, // Pneumonia
      { code: "arexvy", name: "Arexvy" }, // RSV
      { code: "shingrix1", name: "Shingrix" }, // Shingles
      { code: "boostrix", name: "Boostrix" }, // Tetanus (Tdap)
      { code: "gardasil1", name: "Gardasil" }, // HPV
      { code: "engerix1", name: "Engerix-B" }, // Hep B -> Other
      { code: "menveo", name: "Menveo" }, // Meningitis -> Other
      { code: "mystery", name: "Mystery Vaccine" }, // no catalog entry -> Other
    ]);
    const sections = groupMacroRowsBySection(rows);
    const groups = groupSectionsByTopGroup(sections);

    expect(groups.map((g) => g.group)).toEqual(["COVID/Flu", "Common", "Other"]);
    expect(groups[0].sections.map((s) => s.section)).toEqual(["Flu", "COVID"]);
    expect(groups[1].sections.map((s) => s.section)).toEqual(["RSV", "Shingles", "Pneumonia", "Tetanus", "HPV"]);
    expect(groups[2].sections.map((s) => s.section)).toEqual(["Hep B", "Meningitis", "Other"]);
  });

  it("omits a top group entirely when none of its sections have products", () => {
    const rows = rowsFor([{ code: "gardasil1", name: "Gardasil" }]); // HPV -> Common only
    const groups = groupSectionsByTopGroup(groupMacroRowsBySection(rows));
    expect(groups.map((g) => g.group)).toEqual(["Common"]);
  });
});

describe("macroSectionDisplayName", () => {
  it("renames Tetanus to Tdap (Will's verbatim example)", () => {
    expect(macroSectionDisplayName("Tetanus")).toBe("Tdap");
  });

  it("leaves every other section's name unchanged", () => {
    const untouched: MacroRow["section"][] = [
      "Flu",
      "COVID",
      "Pneumonia",
      "RSV",
      "Shingles",
      "Hep B",
      "HPV",
      "Meningitis",
      "Hep A",
      "Typhoid",
      "MMR",
      "Other",
    ];
    for (const section of untouched) {
      expect(macroSectionDisplayName(section)).toBe(section);
    }
  });
});

describe("macroProductNameWithAge", () => {
  it("appends the flattened age in parens", () => {
    expect(macroProductNameWithAge({ displayName: "Boostrix", age: "10+" })).toBe("Boostrix (10+)");
  });

  it("flattens an age that already carries its own parenthetical to a comma clause", () => {
    expect(macroProductNameWithAge({ displayName: "Shingrix", age: "50+ (19+ IC)" })).toBe("Shingrix (50+, 19+ IC)");
  });

  it("omits the suffix entirely for a product with no catalog age", () => {
    expect(macroProductNameWithAge({ displayName: "Mystery Vaccine", age: "" })).toBe("Mystery Vaccine");
  });
});

describe("filterMacroTopGroups", () => {
  function topGroupsFor(codes: { code: string; name: string }[]) {
    const products: ProductView[] = codes.map(({ code, name }) => view({ productKey: `name:${code}`, displayName: name, vaccineIds: [code] }));
    const vaccines: MacroRowVaccine[] = codes.map(({ code, name }) => vaccine({ id: code, name, short_code: code }));
    const rows = buildMacroRows(products, vaccines, {});
    return groupSectionsByTopGroup(groupMacroRowsBySection(rows));
  }

  const fixtureCodes = [
    { code: "flucelvaxmdv", name: "Flucelvax MDV" }, // Flu
    { code: "comirnaty12", name: "Comirnaty" }, // COVID
    { code: "shingrix1", name: "Shingrix" }, // Shingles (name won't contain "shingrix" lowercase substring test uses code)
    { code: "boostrix", name: "Boostrix" }, // Tetanus/Tdap
    { code: "gardasil1", name: "Gardasil" }, // HPV
  ];

  it("returns the input unchanged (by reference) for an empty/whitespace query", () => {
    const topGroups = topGroupsFor(fixtureCodes);
    expect(filterMacroTopGroups(topGroups, "")).toBe(topGroups);
    expect(filterMacroTopGroups(topGroups, "   ")).toBe(topGroups);
  });

  it("matches by product display name, case-insensitively", () => {
    const topGroups = topGroupsFor(fixtureCodes);
    const filtered = filterMacroTopGroups(topGroups, "boost");
    const names = filtered.flatMap((g) => g.sections.flatMap((s) => s.products.map((p) => p.displayName)));
    expect(names).toEqual(["Boostrix"]);
  });

  it("matches by short code even when it isn't a substring of the display name", () => {
    const topGroups = topGroupsFor(fixtureCodes);
    const filtered = filterMacroTopGroups(topGroups, "gardasil1");
    const names = filtered.flatMap((g) => g.sections.flatMap((s) => s.products.map((p) => p.displayName)));
    expect(names).toEqual(["Gardasil"]);
  });

  it("matches a section's display-name override, e.g. 'tdap' finds the whole Tetanus section", () => {
    const topGroups = topGroupsFor(fixtureCodes);
    const filtered = filterMacroTopGroups(topGroups, "tdap");
    const names = filtered.flatMap((g) => g.sections.flatMap((s) => s.products.map((p) => p.displayName)));
    expect(names).toEqual(["Boostrix"]);
  });

  it("omits sections and groups with zero matches", () => {
    const topGroups = topGroupsFor(fixtureCodes);
    const filtered = filterMacroTopGroups(topGroups, "gardasil1");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].group).toBe("Common");
    expect(filtered[0].sections.map((s) => s.section)).toEqual(["HPV"]);
  });

  it("returns no groups at all when nothing matches", () => {
    const topGroups = topGroupsFor(fixtureCodes);
    expect(filterMacroTopGroups(topGroups, "nonexistent-product-xyz")).toEqual([]);
  });

  it("ROUND 9 (Will's verbatim brief): also matches a product's special-qualification note", () => {
    const products: ProductView[] = [view({ productKey: "ndc:shingrix", displayName: "Shingrix", vaccineIds: ["s1"] })];
    const vaccines: MacroRowVaccine[] = [vaccine({ id: "s1", name: "Shingrix", short_code: "shingrix1" })];
    const rows = buildMacroRows(products, vaccines, {});
    const topGroups = groupSectionsByTopGroup(groupMacroRowsBySection(rows));

    const filtered = filterMacroTopGroups(topGroups, "immunocompromised");
    const names = filtered.flatMap((g) => g.sections.flatMap((s) => s.products.map((p) => p.displayName)));
    expect(names).toEqual(["Shingrix"]);
  });
});

describe("getMacroViewMode / MACRO_VIEW_MODE (V-T48: C is the only layout)", () => {
  it("MACRO_VIEW_MODE is 'C'", () => {
    expect(MACRO_VIEW_MODE).toBe("C");
  });

  it("getMacroViewMode always returns 'C' — no switcher, nothing persisted, nothing else to select", () => {
    expect(getMacroViewMode()).toBe("C");
    // Pure and argument-free: calling it repeatedly can never return
    // anything else (there's no removed A/B value a stale caller could
    // still coax out of it).
    expect(getMacroViewMode()).toBe(getMacroViewMode());
  });
});
