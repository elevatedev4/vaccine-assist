import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOSE_COUNTS,
  buildMacroCode,
  buildMacroRows,
  expToMacroDate,
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

describe("DEFAULT_DOSE_COUNTS", () => {
  it("matches every multi-dose base named in Will's brief", () => {
    expect(DEFAULT_DOSE_COUNTS).toEqual({
      shingrix: 2,
      engerix: 3,
      gardasil: 3,
      mmr: 2,
      priorix: 2,
      vaqtaadult: 2,
      twinrix: 3,
      heplisav: 2,
    });
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
    ...overrides,
  };
}

describe("buildMacroRows", () => {
  it("expands a multi-dose product into one row per dose, using each real vaccine row's own short_code AS-IS (no double-suffixing)", () => {
    const products: ProductView[] = [
      view({ productKey: "ndc:engerix", displayName: "Engerix 20 (age 20+)", ndc: "58160082152", packageSize: 10, group: "Other", vaccineIds: ["e1", "e2", "e3"] }),
    ];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "e1", name: "Engerix 20 (age 20+)", dose: "1", short_code: "engerix1" }),
      vaccine({ id: "e2", name: "Engerix 20 (age 20+)", dose: "2", short_code: "engerix2" }),
      vaccine({ id: "e3", name: "Engerix 20 (age 20+)", dose: "3", short_code: "engerix3" }),
    ];
    const activeLots = {
      e1: [{ status: "active", expiration: "2028-08-14", lot_number: "2GZ34" }],
      e2: [{ status: "active", expiration: "2028-08-14", lot_number: "2GZ34" }],
      e3: [{ status: "active", expiration: "2028-08-14", lot_number: "2GZ34" }],
    };

    const rows = buildMacroRows(products, vaccines, activeLots, {});
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.macro)).toEqual(["engerix1,2GZ34,08142028", "engerix2,2GZ34,08142028", "engerix3,2GZ34,08142028"]);
    expect(rows.every((r) => r.complete)).toBe(true);
    expect(rows.every((r) => r.vaccineIds.length === 3)).toBe(true);
    expect(rows.map((r) => r.doseNumber)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.doseCount === 3)).toBe(true);
  });

  it("a single-dose product gets exactly one row with no suffix", () => {
    const products: ProductView[] = [view({ productKey: "ndc:comirnaty", displayName: "Comirnaty 2025-26 12+", vaccineIds: ["c1"] })];
    const vaccines: MacroRowVaccine[] = [vaccine({ id: "c1", name: "Comirnaty 2025-26 12+", dose: "1", short_code: "comirnaty12" })];
    const activeLots = { c1: [{ status: "active", expiration: "2027-06-22", lot_number: "RM3739" }] };

    const rows = buildMacroRows(products, vaccines, activeLots, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].macro).toBe("comirnaty12,RM3739,06222027");
    expect(rows[0].doseCount).toBe(1);
  });

  it("flags a row incomplete when the vaccine has no active lot on file, without inventing a placeholder date", () => {
    const products: ProductView[] = [view({ productKey: "name:flucelvaxmdv", displayName: "Flucelvax MDV", vaccineIds: ["f1"] })];
    const vaccines: MacroRowVaccine[] = [vaccine({ id: "f1", name: "Flucelvax MDV", dose: "1", short_code: "flucelvaxmdv" })];

    const rows = buildMacroRows(products, vaccines, {}, {});
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

    const rows = buildMacroRows(products, vaccines, {}, {});
    expect(rows.map((r) => r.productKey)).toEqual(["name:active-one"]);
  });

  it("a product whose vaccine rows carry no short_code at all shows a null shortCode/macro row (no short code set)", () => {
    const products: ProductView[] = [view({ productKey: "name:mystery", displayName: "Mystery Vaccine", vaccineIds: ["m1"] })];
    const vaccines: MacroRowVaccine[] = [vaccine({ id: "m1", name: "Mystery Vaccine", short_code: "" })];

    const rows = buildMacroRows(products, vaccines, {}, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].shortCode).toBeNull();
    expect(rows[0].macro).toBeNull();
    expect(rows[0].complete).toBe(false);
  });

  it("respects a macro_dose_counts override, synthesizing a code for a dose beyond the real seeded rows", () => {
    // Shingrix seeded with only 2 real dose rows; Will raises the
    // configured dose count to 3 for this product via the Doses input.
    const products: ProductView[] = [view({ productKey: "ndc:shingrix", displayName: "Shingrix", vaccineIds: ["s1", "s2"] })];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "s1", name: "Shingrix", dose: "1", short_code: "shingrix1" }),
      vaccine({ id: "s2", name: "Shingrix", dose: "2", short_code: "shingrix2" }),
    ];
    const activeLots = {
      s1: [{ status: "active", expiration: "2028-09-29", lot_number: "7C955" }],
      s2: [{ status: "active", expiration: "2028-09-29", lot_number: "7C955" }],
    };

    const rows = buildMacroRows(products, vaccines, activeLots, { "ndc:shingrix": 3 });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.macro)).toEqual([
      "shingrix1,7C955,09292028",
      "shingrix2,7C955,09292028",
      "shingrix3,,", // synthesized dose 3 has no real vaccine row, so no lot on file
    ]);
    expect(rows[2].complete).toBe(false);
  });

  it("defaults doseCount from DEFAULT_DOSE_COUNTS by short_code base when no override is saved", () => {
    const products: ProductView[] = [view({ productKey: "ndc:gardasil", displayName: "Gardasil", vaccineIds: ["g1", "g2", "g3"] })];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "g1", name: "Gardasil", dose: "1", short_code: "gardasil1" }),
      vaccine({ id: "g2", name: "Gardasil", dose: "2", short_code: "gardasil2" }),
      vaccine({ id: "g3", name: "Gardasil", dose: "3", short_code: "gardasil3" }),
    ];

    const rows = buildMacroRows(products, vaccines, {}, {});
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.doseCount === 3)).toBe(true);
  });

  it("orders rows COVID -> Flu -> Other, then alphabetically by display name within each group", () => {
    const products: ProductView[] = [
      view({ productKey: "name:zzz-other", displayName: "Zzz Other Vaccine", group: "Other", vaccineIds: ["z1"] }),
      view({ productKey: "name:aaa-covid", displayName: "Aaa Covid Vaccine", group: "COVID", vaccineIds: ["a1"] }),
      view({ productKey: "name:mmm-flu", displayName: "Mmm Flu Vaccine", group: "Flu", vaccineIds: ["m1"] }),
      view({ productKey: "name:aaa-other", displayName: "Aaa Other Vaccine", group: "Other", vaccineIds: ["b1"] }),
    ];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "z1", name: "Zzz Other Vaccine", short_code: "zzz" }),
      vaccine({ id: "a1", name: "Aaa Covid Vaccine", short_code: "aaacovid" }),
      vaccine({ id: "m1", name: "Mmm Flu Vaccine", short_code: "mmmflu" }),
      vaccine({ id: "b1", name: "Aaa Other Vaccine", short_code: "aaaother" }),
    ];

    const rows = buildMacroRows(products, vaccines, {}, {});
    expect(rows.map((r) => r.displayName)).toEqual([
      "Aaa Covid Vaccine",
      "Mmm Flu Vaccine",
      "Aaa Other Vaccine",
      "Zzz Other Vaccine",
    ]);
  });
});
