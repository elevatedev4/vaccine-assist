import { describe, expect, it } from "vitest";
import { matchScreenerProducts } from "@/lib/screener-macro";
import { buildMacroRows, type MacroLotLike, type MacroRowVaccine } from "@/lib/macro-codes";
import type { ProductView } from "@/lib/product-view";

// buildMacroRows' `today` param (V-lots-bud-spikevax follow-up) — a
// fixed date safely before this file's fixture expiration (2028-09-29).
const TODAY = "2026-01-01";

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

describe("matchScreenerProducts", () => {
  it("finds the real product for a single-short-code screener rule", () => {
    const products: ProductView[] = [
      view({ productKey: "ndc:shingrix", displayName: "Shingrix", vaccineIds: ["s1", "s2"] }),
    ];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "s1", name: "Shingrix", dose: "1", short_code: "shingrix1" }),
      vaccine({ id: "s2", name: "Shingrix", dose: "2", short_code: "shingrix2" }),
    ];
    const lots: Record<string, MacroLotLike[]> = {
      s1: [{ status: "active", expiration: "2028-09-29", lot_number: "7C955" }],
      s2: [{ status: "active", expiration: "2028-09-29", lot_number: "7C955" }],
    };
    const rows = buildMacroRows(products, vaccines, lots, TODAY);

    const matches = matchScreenerProducts(rows, "shingrix");
    expect(matches).toHaveLength(1);
    expect(matches[0].displayName).toBe("Shingrix");
    expect(matches[0].doses).toHaveLength(2);
  });

  it("returns [] when the pharmacy has no matching vaccine on file", () => {
    const products: ProductView[] = [
      view({ productKey: "ndc:shingrix", displayName: "Shingrix", vaccineIds: ["s1"] }),
    ];
    const vaccines: MacroRowVaccine[] = [vaccine({ id: "s1", name: "Shingrix", short_code: "shingrix1" })];
    const rows = buildMacroRows(products, vaccines, {}, TODAY);

    expect(matchScreenerProducts(rows, "capvaxive")).toEqual([]);
  });

  it("returns [] for an id with no SCREENER_RULE_MACRO_INFO entry", () => {
    const rows = buildMacroRows([], [], {}, TODAY);
    expect(matchScreenerProducts(rows, "not-a-real-rule")).toEqual([]);
  });

  it("a rule spanning two real packagings (flucelvax) matches both as separate products", () => {
    const products: ProductView[] = [
      view({ productKey: "name:flucelvaxmdv", displayName: "Flucelvax MDV", vaccineIds: ["f1"] }),
      view({ productKey: "name:flucelvaxpfs", displayName: "Flucelvax PFS", vaccineIds: ["f2"] }),
      view({ productKey: "name:fluad", displayName: "Fluad", vaccineIds: ["f3"] }),
    ];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "f1", name: "Flucelvax MDV", short_code: "flucelvaxmdv" }),
      vaccine({ id: "f2", name: "Flucelvax PFS", short_code: "flucelvaxpfs" }),
      vaccine({ id: "f3", name: "Fluad", short_code: "fluad" }),
    ];
    const rows = buildMacroRows(products, vaccines, {}, TODAY);

    const flucelvaxMatches = matchScreenerProducts(rows, "flucelvax");
    expect(flucelvaxMatches.map((p) => p.displayName).sort()).toEqual(["Flucelvax MDV", "Flucelvax PFS"]);

    // Fluad is a separate screener rule (65+) — never picked up by "flucelvax".
    const fluadMatches = matchScreenerProducts(rows, "fluad");
    expect(fluadMatches.map((p) => p.displayName)).toEqual(["Fluad"]);
  });

  it("matches a multi-dose product via a per-dose short code (e.g. engerix2/engerix3)", () => {
    const products: ProductView[] = [
      view({ productKey: "ndc:engerix", displayName: "Engerix-B", vaccineIds: ["e1", "e2", "e3"] }),
    ];
    const vaccines: MacroRowVaccine[] = [
      vaccine({ id: "e1", name: "Engerix-B", dose: "1", short_code: "engerix1" }),
      vaccine({ id: "e2", name: "Engerix-B", dose: "2", short_code: "engerix2" }),
      vaccine({ id: "e3", name: "Engerix-B", dose: "3", short_code: "engerix3" }),
    ];
    const rows = buildMacroRows(products, vaccines, {}, TODAY);

    const matches = matchScreenerProducts(rows, "engerix-b");
    expect(matches).toHaveLength(1);
    expect(matches[0].doses).toHaveLength(3);
  });
});
