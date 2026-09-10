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
});
