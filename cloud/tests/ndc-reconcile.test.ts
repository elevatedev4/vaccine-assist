import { describe, expect, it } from "vitest";
import { decideNdcAdoptions } from "@/lib/on-hand/ndc-reconcile";
import type { MatchedOnHandRow } from "@/lib/on-hand/pioneer-boh";
import type { CatalogVaccine } from "@/lib/vaccine-matching";

function row(overrides: Partial<MatchedOnHandRow>): MatchedOnHandRow {
  return {
    rawLine: "line",
    vaccineNameRaw: "Product",
    quantity: 10,
    vaccineId: "v1",
    matched: true,
    ndc: "70461002603",
    stockSize: 1,
    matchedByExactNdc: false,
    ...overrides,
  };
}

describe("decideNdcAdoptions", () => {
  it("adopts the report NDC for a name-matched line (Fluad shape: DB ndc is stale, no competing lines)", () => {
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Fluad", ndc: "70461-0123-03" }];
    const rows = [row({ vaccineId: "v1", ndc: "70461002603", quantity: 184, matchedByExactNdc: false })];

    const result = decideNdcAdoptions(rows, catalog);
    expect(result.adoptions).toEqual([
      { vaccineId: "v1", vaccineName: "Fluad", oldNdc: "70461-0123-03", newNdc: "70461-0026-03" },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("adopts the report NDC when the vaccine has no ndc on file at all", () => {
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Flucelvax PFS", ndc: null }];
    const rows = [row({ vaccineId: "v1", ndc: "70461065603", quantity: 50, matchedByExactNdc: false })];

    const result = decideNdcAdoptions(rows, catalog);
    expect(result.adoptions).toEqual([
      { vaccineId: "v1", vaccineName: "Flucelvax PFS", oldNdc: null, newNdc: "70461-0656-03" },
    ]);
  });

  it("does NOT adopt when the winning (highest-stock) line's report NDC already equals the on-file ndc (nothing to change)", () => {
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Widget", ndc: "70461-0026-03" }];
    const rows = [row({ vaccineId: "v1", ndc: "70461002603", quantity: 40, matchedByExactNdc: true })];

    const result = decideNdcAdoptions(rows, catalog);
    expect(result.adoptions).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("Comirnaty case: exact-NDC-matched line has the real stock (291) and already matches vaccine.ndc — the zero-stock name-matched line must NOT overwrite it", () => {
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Comirnaty 2026-27 12+", ndc: "00069-2631-10" }];
    const rows = [
      // Pass 1: exact ndc match, 291 on hand — this is the correct, in-stock package.
      row({ vaccineId: "v1", ndc: "00069263110", quantity: 291, matchedByExactNdc: true }),
      // Pass 4: name match only, an old zero-stock package.
      row({ vaccineId: "v1", ndc: "00069252810", quantity: 0, matchedByExactNdc: false }),
    ];

    const result = decideNdcAdoptions(rows, catalog);
    expect(result.adoptions).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("Fluad case: DB's stale-year NDC line has zero stock, but another line among 3 distinct report NDCs has real stock — adopts THAT line's NDC despite the disagreement", () => {
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Fluad", ndc: "70461-0123-03" }];
    const rows = [
      row({ vaccineId: "v1", ndc: "70461012303", quantity: 0, matchedByExactNdc: true }), // matches stale DB ndc, no stock
      row({ vaccineId: "v1", ndc: "70461002603", quantity: 184, matchedByExactNdc: false }), // real stock
      row({ vaccineId: "v1", ndc: "70461002503", quantity: 0, matchedByExactNdc: false }),
    ];

    const result = decideNdcAdoptions(rows, catalog);
    expect(result.adoptions).toEqual([
      { vaccineId: "v1", vaccineName: "Fluad", oldNdc: "70461-0123-03", newNdc: "70461-0026-03" },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("does NOT adopt when every line for a product has zero (or null) stock", () => {
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Widget", ndc: "99999-9999-99" }];
    const rows = [
      row({ vaccineId: "v1", ndc: "70461002603", quantity: 0, matchedByExactNdc: false }),
      row({ vaccineId: "v1", ndc: "70461002604", quantity: null, matchedByExactNdc: false }),
    ];

    const result = decideNdcAdoptions(rows, catalog);
    expect(result.adoptions).toEqual([]);
    expect(result.skipped).toEqual([{ vaccineId: "v1", vaccineName: "Widget", ndc: "", reason: "no-stock" }]);
  });

  it("does NOT adopt when two lines tie for the highest stock but disagree on NDC", () => {
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Widget", ndc: "99999-9999-99" }];
    const rows = [
      row({ vaccineId: "v1", ndc: "70461002603", quantity: 40, matchedByExactNdc: false }),
      row({ vaccineId: "v1", ndc: "70461002604", quantity: 40, matchedByExactNdc: false }),
    ];

    const result = decideNdcAdoptions(rows, catalog);
    expect(result.adoptions).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ vaccineId: "v1", vaccineName: "Widget", reason: "tie" });
    expect(result.skipped[0].ndc.split(", ").sort()).toEqual(["70461002603", "70461002604"]);
  });

  it("adopts when a product's batch lines agree on the SAME report NDC across multiple rows (no tie — same NDC, not a disagreement)", () => {
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Widget", ndc: "99999-9999-99" }];
    const rows = [
      row({ vaccineId: "v1", ndc: "70461002603", quantity: 20, matchedByExactNdc: false }),
      row({ vaccineId: "v1", ndc: "70461-0026-03", quantity: 20, matchedByExactNdc: false }), // same NDC, dashed
    ];

    const result = decideNdcAdoptions(rows, catalog);
    expect(result.adoptions).toEqual([
      { vaccineId: "v1", vaccineName: "Widget", oldNdc: "99999-9999-99", newNdc: "70461-0026-03" },
    ]);
  });

  it("a lower-stock line does not win even if it disagrees with the highest-stock line's NDC", () => {
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Widget", ndc: "99999-9999-99" }];
    const rows = [
      row({ vaccineId: "v1", ndc: "70461002603", quantity: 5, matchedByExactNdc: false }),
      row({ vaccineId: "v1", ndc: "70461002604", quantity: 200, matchedByExactNdc: false }),
    ];

    const result = decideNdcAdoptions(rows, catalog);
    expect(result.adoptions).toEqual([
      { vaccineId: "v1", vaccineName: "Widget", oldNdc: "99999-9999-99", newNdc: "70461-0026-04" },
    ]);
  });

  it("ignores a row with no report ndc at all", () => {
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Widget", ndc: null }];
    const rows = [row({ vaccineId: "v1", ndc: null, quantity: 100, matchedByExactNdc: false })];

    const result = decideNdcAdoptions(rows, catalog);
    expect(result.adoptions).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("ignores a row with no vaccineId (unmatched)", () => {
    const catalog: CatalogVaccine[] = [];
    const rows = [row({ vaccineId: null, ndc: "70461002603", quantity: 100, matchedByExactNdc: false })];

    const result = decideNdcAdoptions(rows, catalog);
    expect(result.adoptions).toEqual([]);
  });

  it("counts an exact-ndc-matched line as a candidate alongside a higher-stock name-matched line (matchedByExactNdc no longer excludes a line from candidacy)", () => {
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Widget", ndc: "99999-9999-99" }];
    const rows = [
      row({ vaccineId: "v1", ndc: "99999999999", quantity: 3, matchedByExactNdc: true }),
      row({ vaccineId: "v1", ndc: "70461002603", quantity: 300, matchedByExactNdc: false }),
    ];

    const result = decideNdcAdoptions(rows, catalog);
    expect(result.skipped).toEqual([]);
    expect(result.adoptions).toEqual([
      { vaccineId: "v1", vaccineName: "Widget", oldNdc: "99999-9999-99", newNdc: "70461-0026-03" },
    ]);
  });

  // --- Review fix (reviewer REQUEST_CHANGES on b610ea5): decideNdcAdoptions
  // "adopts backwards" without awareness of lib/vaccine-product-catalog.ts's
  // altNdcs. Reproduced with the REAL Abrysvo catalog entry (match.ndc
  // "00069246510", altNdcs ["00069034401", "00069246501"] —
  // lib/vaccine-product-catalog.ts's seed table, not a fixture) — these
  // tests deliberately use the real "Abrysvo" name so they exercise the
  // real static catalog lookup, the same one production code path uses.
  // Each fixture is set up so the GUARDED line is the one that wins the
  // stock-based selection (fix/ndc-adopt-in-stock), to prove the guards
  // still fire post-selection. ---
  describe("guards against adopting a known altNdc or another product's NDC (review fix, still enforced after stock-based selection)", () => {
    it("does NOT adopt a known OLD alt NDC for the SAME product (the exact reviewer repro: Abrysvo 10ct's own altNdc, the 1ct product's real NDC) even when it's the highest-stock line", () => {
      const catalog: CatalogVaccine[] = [{ id: "v1", name: "Abrysvo", ndc: "00069-2465-10" }];
      const rows = [row({ vaccineId: "v1", ndc: "00069246501", quantity: 15, matchedByExactNdc: false })];

      const result = decideNdcAdoptions(rows, catalog);
      expect(result.adoptions).toEqual([]);
      expect(result.skipped).toEqual([
        { vaccineId: "v1", vaccineName: "Abrysvo", ndc: "00069246501", reason: "alt-ndc" },
      ]);
    });

    it("DOES adopt a genuinely new NDC that is neither an altNdc nor any other product's NDC", () => {
      const catalog: CatalogVaccine[] = [{ id: "v1", name: "Abrysvo", ndc: "00069-2465-10" }];
      const rows = [row({ vaccineId: "v1", ndc: "00069246599", quantity: 15, matchedByExactNdc: false })];

      const result = decideNdcAdoptions(rows, catalog);
      expect(result.skipped).toEqual([]);
      expect(result.adoptions).toEqual([
        { vaccineId: "v1", vaccineName: "Abrysvo", oldNdc: "00069-2465-10", newNdc: "00069-2465-99" },
      ]);
    });

    it("does NOT adopt an NDC that is already on file as a DIFFERENT vaccine row's own ndc, even when it's the highest-stock line", () => {
      const catalog: CatalogVaccine[] = [
        { id: "v1", name: "ProductA", ndc: "11111-1111-11" },
        { id: "v2", name: "ProductB", ndc: "22222-2222-22" },
      ];
      const rows = [row({ vaccineId: "v1", ndc: "22222222222", quantity: 15, matchedByExactNdc: false })];

      const result = decideNdcAdoptions(rows, catalog);
      expect(result.adoptions).toEqual([]);
      expect(result.skipped).toEqual([
        { vaccineId: "v1", vaccineName: "ProductA", ndc: "22222222222", reason: "other-product" },
      ]);
    });

    it("does NOT adopt an NDC that belongs to a DIFFERENT product in the static research catalog, even with no DB row claiming it yet", () => {
      // No DB row has "00069246510" (Abrysvo 10ct's real primary NDC) on
      // file — this row matched some other, unrelated catalog product by
      // name — so only the static-catalog guard (not the DB-row guard)
      // catches this one.
      const catalog: CatalogVaccine[] = [{ id: "v1", name: "SomeUnrelatedProduct", ndc: null }];
      const rows = [row({ vaccineId: "v1", ndc: "00069246510", quantity: 15, matchedByExactNdc: false })];

      const result = decideNdcAdoptions(rows, catalog);
      expect(result.adoptions).toEqual([]);
      expect(result.skipped).toEqual([
        { vaccineId: "v1", vaccineName: "SomeUnrelatedProduct", ndc: "00069246510", reason: "other-product" },
      ]);
    });

    it("does NOT adopt when TWO different products in the same batch both resolve (as their highest-stock line) to the SAME candidate NDC (cross-batch dedupe)", () => {
      const catalog: CatalogVaccine[] = [
        { id: "v1", name: "ProductA", ndc: "11111-1111-11" },
        { id: "v2", name: "ProductB", ndc: "22222-2222-22" },
      ];
      const rows = [
        row({ vaccineId: "v1", ndc: "99999999999", quantity: 15, matchedByExactNdc: false }),
        row({ vaccineId: "v2", ndc: "99999999999", quantity: 25, matchedByExactNdc: false }),
      ];

      const result = decideNdcAdoptions(rows, catalog);
      expect(result.adoptions).toEqual([]);
      expect(result.skipped).toEqual(
        expect.arrayContaining([
          { vaccineId: "v1", vaccineName: "ProductA", ndc: "99999999999", reason: "duplicate-in-batch" },
          { vaccineId: "v2", vaccineName: "ProductB", ndc: "99999999999", reason: "duplicate-in-batch" },
        ])
      );
      expect(result.skipped).toHaveLength(2);
    });
  });
});
