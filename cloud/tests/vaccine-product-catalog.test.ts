import { describe, expect, it } from "vitest";
import {
  computeOrderPackages,
  displayNameFor,
  findInCatalog,
  lookupProduct,
  type ProductCatalogEntry,
} from "@/lib/vaccine-product-catalog";

// The 27 active catalog vaccine names on file (V-T26 item 7, Will
// 2026-09-09 research pass) — every one of these must resolve to a
// CATALOG row via lookupProduct's exact-name fallback, even for a
// product with no NDC on file yet.
const ACTIVE_CATALOG_NAMES = [
  "Abrysvo",
  "Boostrix",
  "Capvaxive",
  "Comirnaty 2025-26 12+",
  "Engerix 20 (age 20+)",
  "Fluad",
  "Flucelvax PFS",
  "FluMist (age 2-49)",
  "Gardasil",
  "Menveo",
  "MMR-II",
  "mNEXSPIKE",
  "Pneumovax 23",
  "Prevnar 20",
  "Shingrix",
  "Spikevax",
  "Typhim Vi",
  "Vaqta adult",
  "Afluria MDV",
  "Afluria PFS",
  "Arexvy",
  "Fluarix PFS",
  "Flucelvax MDV",
  "Flulaval",
  "Fluzone HD",
  "Fluzone PFS",
  "Priorix",
];

describe("vaccine-product-catalog seed data (V-T26 item 7)", () => {
  it("has exactly one row per active catalog name (no accidental duplicates)", () => {
    // Sanity check on the seed itself, independent of lookupProduct's
    // matching order — every name below should resolve to a distinct
    // productName via the by-name path.
    const resolved = new Set(ACTIVE_CATALOG_NAMES.map((name) => lookupProduct({ name })?.productName));
    expect(resolved.size).toBe(ACTIVE_CATALOG_NAMES.length);
  });

  it.each(ACTIVE_CATALOG_NAMES)("resolves catalog name %j to a product with a positive dosesPerPackage", (name) => {
    const product = lookupProduct({ name });
    expect(product).not.toBeNull();
    expect(product?.productName).toEqual(expect.any(String));
    expect(product?.dosesPerPackage).toBeGreaterThan(0);
  });

  it("resolves Prevnar 20's on-file comma-list NDC to the 10-pack (first NDC in the list)", () => {
    const product = lookupProduct({ ndc: "00005-2000-10, 00005-2000-02", name: "Prevnar 20" });
    expect(product).toEqual({
      productName: "Prevnar 20",
      ageRange: "19+ (label 6 wk+)",
      dosesPerPackage: 10,
      packageNdc: "00005-2000-10",
    });
  });

  it("resolves a Comirnaty rename via namePrefix (on-file name may change to '2026-27' soon)", () => {
    const product = lookupProduct({ name: "Comirnaty 2026-27 12+" });
    expect(product?.productName).toBe("Comirnaty 2026-2027 Formula");
  });

  it("resolves the real Gardasil row by its on-file NDC (dashed form)", () => {
    const product = lookupProduct({ ndc: "00006-4121-02", name: "Gardasil" });
    expect(product).toMatchObject({ productName: "Gardasil 9", ageRange: "9-45 yr", dosesPerPackage: 10 });
  });

  it("returns null for a name/NDC the catalog doesn't carry", () => {
    expect(lookupProduct({ name: "Some Future Vaccine", ndc: "99999999999" })).toBeNull();
  });
});

describe("findInCatalog", () => {
  const FIXTURE: ProductCatalogEntry[] = [
    { match: { ndc: "00006-4121-02" }, productName: "Gardasil 9", ageRange: "9-45", dosesPerPackage: 10, packageNdc: "00006-4121-10" },
    { match: { name: "Flu Quad 2025-26" }, productName: "Flu Quad", dosesPerPackage: 10 },
    { match: { namePrefix: "Comirnaty" }, productName: "Comirnaty (any formula)", ageRange: "12+", dosesPerPackage: 10 },
  ];

  it("matches by normalized NDC first, dashed or undashed against a dashed entry", () => {
    expect(findInCatalog(FIXTURE, { ndc: "00006412102" })?.productName).toBe("Gardasil 9");
    expect(findInCatalog(FIXTURE, { ndc: "00006-4121-02" })?.productName).toBe("Gardasil 9");
  });

  it("falls back to exact case-insensitive, trimmed name when NDC doesn't match", () => {
    expect(findInCatalog(FIXTURE, { name: "  FLU QUAD 2025-26  " })?.productName).toBe("Flu Quad");
  });

  it("falls back to namePrefix (case-insensitive) when neither NDC nor exact name matches", () => {
    expect(findInCatalog(FIXTURE, { name: "Comirnaty 2026-27 12+" })?.productName).toBe("Comirnaty (any formula)");
  });

  it("prefers an NDC match over a name/namePrefix match when both could apply", () => {
    expect(findInCatalog(FIXTURE, { ndc: "00006-4121-02", name: "Comirnaty 2026-27 12+" })?.productName).toBe("Gardasil 9");
  });

  it("returns null when nothing matches", () => {
    expect(findInCatalog(FIXTURE, { name: "Unknown Vaccine", ndc: "11111111111" })).toBeNull();
  });

  it("returns null for an empty catalog (today's real seed shape before this research pass)", () => {
    expect(findInCatalog([], { name: "Anything", ndc: "00006412102" })).toBeNull();
  });
});

describe("computeOrderPackages", () => {
  it("rounds up to the next whole package (ceil)", () => {
    expect(computeOrderPackages(21, 10)).toBe(3);
    expect(computeOrderPackages(20, 10)).toBe(2);
    expect(computeOrderPackages(1, 10)).toBe(1);
  });

  it("returns 0 packages for 0 order doses", () => {
    expect(computeOrderPackages(0, 10)).toBe(0);
  });

  it("returns null when dosesPerPackage is unknown (null/undefined)", () => {
    expect(computeOrderPackages(10, null)).toBeNull();
    expect(computeOrderPackages(10, undefined)).toBeNull();
  });

  it("returns null (never divides by zero) for a non-positive dosesPerPackage", () => {
    expect(computeOrderPackages(10, 0)).toBeNull();
    expect(computeOrderPackages(10, -1)).toBeNull();
  });
});

describe("displayNameFor", () => {
  it("uses `productName (ageRange)` when the catalog knows both", () => {
    expect(displayNameFor("Gardasil", "00006-4121-02")).toBe("Gardasil 9 (9-45 yr)");
  });

  it("falls back to today's plain vaccine name when the catalog has no match", () => {
    expect(displayNameFor("Some Unresearched Vaccine", null)).toBe("Some Unresearched Vaccine");
  });
});
