import { describe, expect, it } from "vitest";
import {
  computeOrderPackages,
  displayNameFor,
  findInCatalog,
  formatProductDisplayName,
  lookupProduct,
  normalizeProductBaseName,
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
      ageRange: "19+",
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

// --- V-catalog-name-prefix additions (review follow-up: the lot-list
// apply renamed DB rows mid-season — "mNEXSPIKE" -> "mNEXSPIKE 2026-27",
// "Comirnaty 2025-26 12+" -> "Comirnaty 2026-27 12+" — and exact-name
// matching silently dropped pkg size/age range/NDC-fallback for BOTH). ---

describe("normalizeProductBaseName", () => {
  it("strips a season token in any of the three observed shapes", () => {
    expect(normalizeProductBaseName("Comirnaty 2025-26 12+")).toBe("comirnaty 12+");
    expect(normalizeProductBaseName("Comirnaty 2026-27 12+")).toBe("comirnaty 12+");
    expect(normalizeProductBaseName("Comirnaty 2026-2027 12+")).toBe("comirnaty 12+");
  });

  it("strips a trailing season token with nothing else left over", () => {
    expect(normalizeProductBaseName("mNEXSPIKE 2026-27")).toBe("mnexspike");
  });

  it("strips parentheticals and collapses extra whitespace", () => {
    expect(normalizeProductBaseName("FluMist  (age 2-49)")).toBe("flumist");
    expect(normalizeProductBaseName("Engerix 20 (age 20+)")).toBe("engerix 20");
  });

  it("lowercases and trims", () => {
    expect(normalizeProductBaseName("  Fluad  ")).toBe("fluad");
  });
});

describe("season-agnostic name matching against the REAL seed catalog", () => {
  it("mNEXSPIKE 2026-27 (post-rename DB name) still resolves — pkg size/NDC no longer drop to null", () => {
    const product = lookupProduct({ name: "mNEXSPIKE 2026-27" });
    expect(product).toMatchObject({ productName: "mNEXSPIKE (2026-27)", dosesPerPackage: 10 });
    expect(product?.packageNdc).not.toBeNull();
  });

  it("Comirnaty 2026-27 12+ (post-rename DB name) still resolves with a package NDC", () => {
    const product = lookupProduct({ name: "Comirnaty 2026-27 12+" });
    expect(product).toMatchObject({ productName: "Comirnaty 2026-2027 Formula", dosesPerPackage: 10 });
    expect(product?.packageNdc).not.toBeNull();
  });
});

describe("findInCatalog: 'Fluad' vs 'Fluad Trivalent'", () => {
  const fixture: ProductCatalogEntry[] = [
    { match: { name: "Fluad" }, productName: "Fluad Trivalent (2026-27)", dosesPerPackage: 10 },
    { match: { name: "Flucelvax PFS" }, productName: "Flucelvax (2026-27, PFS)", dosesPerPackage: 10 },
  ];

  it("'Fluad' matches the Fluad row exactly (unchanged fast path)", () => {
    expect(findInCatalog(fixture, { name: "Fluad" })?.productName).toBe("Fluad Trivalent (2026-27)");
  });

  it("'Fluad Trivalent' (a superset rename, no season token at all) also resolves via base-name prefix tolerance", () => {
    expect(findInCatalog(fixture, { name: "Fluad Trivalent" })?.productName).toBe("Fluad Trivalent (2026-27)");
  });

  it("never confuses 'Fluad Trivalent' with the unrelated Flucelvax PFS row", () => {
    expect(findInCatalog(fixture, { name: "Flucelvax PFS" })?.productName).toBe("Flucelvax (2026-27, PFS)");
  });

  it("NDC-first precedence is unchanged: an NDC match wins even when the name would ALSO resolve via base-name matching", () => {
    const withNdc: ProductCatalogEntry[] = [
      { match: { ndc: "00006-4121-02" }, productName: "Gardasil 9", dosesPerPackage: 10 },
      { match: { name: "mNEXSPIKE" }, productName: "mNEXSPIKE (2026-27)", dosesPerPackage: 10 },
    ];
    expect(findInCatalog(withNdc, { ndc: "00006-4121-02", name: "mNEXSPIKE 2026-27" })?.productName).toBe("Gardasil 9");
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
  it("uses `productName (ageRange)` when the catalog knows both and ageRange is flat (no parens)", () => {
    expect(displayNameFor("Gardasil", "00006-4121-02")).toBe("Gardasil 9 (9-45 yr)");
  });

  it("falls back to today's plain vaccine name when the catalog has no match", () => {
    expect(displayNameFor("Some Unresearched Vaccine", null)).toBe("Some Unresearched Vaccine");
  });

  // V-T26 followups (Will 2026-09-09): every real seed ageRange is flat
  // today (Capvaxive/Prevnar 20 fixed from a nested-parens form — see
  // the CATALOG below), but this locks down the fallback rendering rule
  // itself against a future ageRange that isn't.
  it("formatProductDisplayName uses `productName — ageRange` (em dash, no wrapping parens) when ageRange itself contains parentheses", () => {
    expect(formatProductDisplayName("Test Product", "18+ (2-17 high-risk)")).toBe("Test Product — 18+ (2-17 high-risk)");
    expect(formatProductDisplayName("Test Product", ")just a paren")).toBe("Test Product — )just a paren");
  });

  it("formatProductDisplayName uses `productName (ageRange)` when ageRange has no parentheses", () => {
    expect(formatProductDisplayName("Test Product", "18+")).toBe("Test Product (18+)");
  });

  it("formatProductDisplayName returns just productName when ageRange is null", () => {
    expect(formatProductDisplayName("Test Product", null)).toBe("Test Product");
  });

  it("Capvaxive's real seed row renders flat (no nested parentheses)", () => {
    expect(displayNameFor("Capvaxive", null)).toBe("Capvaxive (18+; 2-17 high-risk)");
  });

  it("Prevnar 20's real seed row renders flat (no nested parentheses)", () => {
    expect(displayNameFor("Prevnar 20", "00005-2000-10, 00005-2000-02")).toBe("Prevnar 20 (19+)");
  });
});
