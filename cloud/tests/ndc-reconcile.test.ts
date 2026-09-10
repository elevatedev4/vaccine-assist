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
  it("adopts the report NDC for a name-matched line (Fluad shape: DB ndc is stale)", () => {
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Fluad", ndc: "70461-0123-03" }];
    const rows = [row({ vaccineId: "v1", ndc: "70461002603", matchedByExactNdc: false })];

    const result = decideNdcAdoptions(rows, catalog);
    expect(result.adoptions).toEqual([
      { vaccineId: "v1", vaccineName: "Fluad", oldNdc: "70461-0123-03", newNdc: "70461-0026-03" },
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it("adopts the report NDC when the vaccine has no ndc on file at all", () => {
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Flucelvax PFS", ndc: null }];
    const rows = [row({ vaccineId: "v1", ndc: "70461065603", matchedByExactNdc: false })];

    const result = decideNdcAdoptions(rows, catalog);
    expect(result.adoptions).toEqual([
      { vaccineId: "v1", vaccineName: "Flucelvax PFS", oldNdc: null, newNdc: "70461-0656-03" },
    ]);
  });

  it("does NOT adopt when the line matched by EXACT ndc (pass 1) — already correct on file", () => {
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Widget", ndc: "70461-0026-03" }];
    const rows = [row({ vaccineId: "v1", ndc: "70461002603", matchedByExactNdc: true })];

    const result = decideNdcAdoptions(rows, catalog);
    expect(result.adoptions).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("does NOT adopt when the report NDC already equals the on-file ndc (nothing to change)", () => {
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Widget", ndc: "70461-0026-03" }];
    // matchedByExactNdc:false here is contrived (a real exact match would
    // set it true), but the "already equal, nothing to adopt" guard
    // should hold regardless of how the row got matched.
    const rows = [row({ vaccineId: "v1", ndc: "70461002603", matchedByExactNdc: false })];

    const result = decideNdcAdoptions(rows, catalog);
    expect(result.adoptions).toEqual([]);
  });

  it("leaves vaccine.ndc alone and reports a conflict when a product's batch lines carry more than one distinct report NDC", () => {
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Widget", ndc: "99999-9999-99" }];
    const rows = [
      row({ vaccineId: "v1", ndc: "70461002603", matchedByExactNdc: false }),
      row({ vaccineId: "v1", ndc: "70461002604", matchedByExactNdc: false }),
    ];

    const result = decideNdcAdoptions(rows, catalog);
    expect(result.adoptions).toEqual([]);
    expect(result.conflicts).toEqual([
      { vaccineId: "v1", vaccineName: "Widget", ndcs: expect.arrayContaining(["70461002603", "70461002604"]) },
    ]);
    expect(result.conflicts[0].ndcs).toHaveLength(2);
  });

  it("adopts when a product's batch lines agree on the SAME report NDC across multiple rows", () => {
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Widget", ndc: "99999-9999-99" }];
    const rows = [
      row({ vaccineId: "v1", ndc: "70461002603", matchedByExactNdc: false }),
      row({ vaccineId: "v1", ndc: "70461-0026-03", matchedByExactNdc: false }), // same NDC, dashed
    ];

    const result = decideNdcAdoptions(rows, catalog);
    expect(result.adoptions).toEqual([
      { vaccineId: "v1", vaccineName: "Widget", oldNdc: "99999-9999-99", newNdc: "70461-0026-03" },
    ]);
  });

  it("ignores a row with no report ndc at all", () => {
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Widget", ndc: null }];
    const rows = [row({ vaccineId: "v1", ndc: null, matchedByExactNdc: false })];

    const result = decideNdcAdoptions(rows, catalog);
    expect(result.adoptions).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("ignores a row with no vaccineId (unmatched)", () => {
    const catalog: CatalogVaccine[] = [];
    const rows = [row({ vaccineId: null, ndc: "70461002603", matchedByExactNdc: false })];

    const result = decideNdcAdoptions(rows, catalog);
    expect(result.adoptions).toEqual([]);
  });

  it("does not mix exact-ndc-matched lines into a conflicting product's candidate set", () => {
    // Two lines for the same product: one matched by exact ndc (ignored
    // for reconciliation purposes) and one matched by name carrying a
    // DIFFERENT report ndc — only the name-matched line counts, so this
    // is a single-candidate adoption, not a conflict.
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Widget", ndc: "99999-9999-99" }];
    const rows = [
      row({ vaccineId: "v1", ndc: "99999999999", matchedByExactNdc: true }),
      row({ vaccineId: "v1", ndc: "70461002603", matchedByExactNdc: false }),
    ];

    const result = decideNdcAdoptions(rows, catalog);
    expect(result.conflicts).toEqual([]);
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
  // real static catalog lookup, the same one production code path uses. ---
  describe("guards against adopting a known altNdc or another product's NDC (review fix)", () => {
    it("does NOT adopt a known OLD alt NDC for the SAME product (the exact reviewer repro: Abrysvo 10ct's own altNdc, the 1ct product's real NDC)", () => {
      const catalog: CatalogVaccine[] = [{ id: "v1", name: "Abrysvo", ndc: "00069-2465-10" }];
      const rows = [row({ vaccineId: "v1", ndc: "00069246501", matchedByExactNdc: false })];

      const result = decideNdcAdoptions(rows, catalog);
      expect(result.adoptions).toEqual([]);
      expect(result.skipped).toEqual([
        { vaccineId: "v1", vaccineName: "Abrysvo", ndc: "00069246501", reason: "alt-ndc" },
      ]);
    });

    it("DOES adopt a genuinely new NDC that is neither an altNdc nor any other product's NDC", () => {
      const catalog: CatalogVaccine[] = [{ id: "v1", name: "Abrysvo", ndc: "00069-2465-10" }];
      const rows = [row({ vaccineId: "v1", ndc: "00069246599", matchedByExactNdc: false })];

      const result = decideNdcAdoptions(rows, catalog);
      expect(result.skipped).toEqual([]);
      expect(result.adoptions).toEqual([
        { vaccineId: "v1", vaccineName: "Abrysvo", oldNdc: "00069-2465-10", newNdc: "00069-2465-99" },
      ]);
    });

    it("does NOT adopt an NDC that is already on file as a DIFFERENT vaccine row's own ndc", () => {
      const catalog: CatalogVaccine[] = [
        { id: "v1", name: "ProductA", ndc: "11111-1111-11" },
        { id: "v2", name: "ProductB", ndc: "22222-2222-22" },
      ];
      const rows = [row({ vaccineId: "v1", ndc: "22222222222", matchedByExactNdc: false })];

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
      const rows = [row({ vaccineId: "v1", ndc: "00069246510", matchedByExactNdc: false })];

      const result = decideNdcAdoptions(rows, catalog);
      expect(result.adoptions).toEqual([]);
      expect(result.skipped).toEqual([
        { vaccineId: "v1", vaccineName: "SomeUnrelatedProduct", ndc: "00069246510", reason: "other-product" },
      ]);
    });

    it("does NOT adopt when TWO different products in the same batch both resolve to the SAME candidate NDC (cross-batch dedupe)", () => {
      const catalog: CatalogVaccine[] = [
        { id: "v1", name: "ProductA", ndc: "11111-1111-11" },
        { id: "v2", name: "ProductB", ndc: "22222-2222-22" },
      ];
      const rows = [
        row({ vaccineId: "v1", ndc: "99999999999", matchedByExactNdc: false }),
        row({ vaccineId: "v2", ndc: "99999999999", matchedByExactNdc: false }),
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
