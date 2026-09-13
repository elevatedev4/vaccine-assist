import { describe, expect, it } from "vitest";
import {
  buildDosesGivenPivot,
  dosesGivenPivotToCsv,
  productTotalsDescending,
  productTotalsToCsv,
  resolveDoseProductName,
  type DosesGivenSourceDay,
} from "@/lib/doses-given";

describe("resolveDoseProductName", () => {
  it("uses the catalog display name when the vaccineId is known", () => {
    const name = resolveDoseProductName(
      { itemName: "FLUAD QUADRIVALENT PF SYR", vaccineId: "v-fluad" },
      { "v-fluad": "Fluad" }
    );
    expect(name).toBe("Fluad");
  });

  it("falls back to the raw itemName when vaccineId is null (unmatched)", () => {
    const name = resolveDoseProductName({ itemName: "MYSTERY DOSE", vaccineId: null }, {});
    expect(name).toBe("MYSTERY DOSE");
  });

  it("falls back to the raw itemName when vaccineId has no catalog entry", () => {
    const name = resolveDoseProductName({ itemName: "SOME ITEM", vaccineId: "v-unknown" }, { "v-fluad": "Fluad" });
    expect(name).toBe("SOME ITEM");
  });
});

describe("buildDosesGivenPivot", () => {
  const nameByVaccineId: Record<string, string> = { "v-fluad": "Fluad", "v-shingrix": "Shingrix" };
  const resolveProductName = (row: { itemName: string; vaccineId: string | null }) =>
    resolveDoseProductName(row, nameByVaccineId);

  const days: DosesGivenSourceDay[] = [
    {
      date: "2026-09-01",
      rows: [
        { itemName: "FLUAD", vaccineId: "v-fluad" },
        { itemName: "FLUAD", vaccineId: "v-fluad" },
        { itemName: "SHINGRIX", vaccineId: "v-shingrix" },
      ],
    },
    {
      date: "2026-09-02",
      rows: [{ itemName: "UNMATCHED ITEM", vaccineId: null }],
    },
    // A day with no ingested rows at all must still appear as a zero
    // row in the pivot — synthetic "quiet day" case.
    { date: "2026-09-03", rows: [] },
  ];

  it("includes every date in the requested range, even a day with zero doses", () => {
    const pivot = buildDosesGivenPivot(days, resolveProductName);
    expect(pivot.dates).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(pivot.totalsByDate["2026-09-03"]).toBe(0);
  });

  it("collects every distinct resolved product name, alphabetically", () => {
    const pivot = buildDosesGivenPivot(days, resolveProductName);
    expect(pivot.products).toEqual(["Fluad", "Shingrix", "UNMATCHED ITEM"]);
  });

  it("builds a dense day x product grid with correct per-cell counts", () => {
    const pivot = buildDosesGivenPivot(days, resolveProductName);
    expect(pivot.countsByDateProduct["2026-09-01"]).toEqual({ Fluad: 2, Shingrix: 1, "UNMATCHED ITEM": 0 });
    expect(pivot.countsByDateProduct["2026-09-02"]).toEqual({ Fluad: 0, Shingrix: 0, "UNMATCHED ITEM": 1 });
    expect(pivot.countsByDateProduct["2026-09-03"]).toEqual({ Fluad: 0, Shingrix: 0, "UNMATCHED ITEM": 0 });
  });

  it("computes correct per-day, per-product, and grand totals", () => {
    const pivot = buildDosesGivenPivot(days, resolveProductName);
    expect(pivot.totalsByDate).toEqual({ "2026-09-01": 3, "2026-09-02": 1, "2026-09-03": 0 });
    expect(pivot.totalsByProduct).toEqual({ Fluad: 2, Shingrix: 1, "UNMATCHED ITEM": 1 });
    expect(pivot.grandTotal).toBe(4);
  });

  it("handles an entirely empty range", () => {
    const pivot = buildDosesGivenPivot([], resolveProductName);
    expect(pivot).toEqual({
      dates: [],
      products: [],
      countsByDateProduct: {},
      totalsByDate: {},
      totalsByProduct: {},
      grandTotal: 0,
    });
  });
});

describe("productTotalsDescending", () => {
  it("sorts by total descending, ties broken alphabetically", () => {
    const pivot = buildDosesGivenPivot(
      [
        {
          date: "2026-09-01",
          rows: [
            { itemName: "A", vaccineId: null },
            { itemName: "B", vaccineId: null },
            { itemName: "B", vaccineId: null },
            { itemName: "C", vaccineId: null },
            { itemName: "C", vaccineId: null },
          ],
        },
      ],
      (row) => row.itemName
    );
    expect(productTotalsDescending(pivot)).toEqual([
      { product: "B", total: 2 },
      { product: "C", total: 2 },
      { product: "A", total: 1 },
    ]);
  });
});

describe("CSV export", () => {
  const nameByVaccineId: Record<string, string> = { "v-fluad": "Fluad" };
  const pivot = buildDosesGivenPivot(
    [{ date: "2026-09-01", rows: [{ itemName: "FLUAD", vaccineId: "v-fluad" }] }],
    (row) => resolveDoseProductName(row, nameByVaccineId)
  );

  it("dosesGivenPivotToCsv renders the day x product grid with a trailing Total row", () => {
    const csv = dosesGivenPivotToCsv(pivot);
    expect(csv).toBe(["Date,Fluad,Total", "2026-09-01,1,1", "Total,1,1"].join("\n"));
  });

  it("productTotalsToCsv renders one row per product plus a trailing grand total", () => {
    const csv = productTotalsToCsv(pivot);
    expect(csv).toBe(["Product,Total", "Fluad,1", "Total,1"].join("\n"));
  });

  it("quotes a product name containing a comma", () => {
    const commaPivot = buildDosesGivenPivot(
      [{ date: "2026-09-01", rows: [{ itemName: "Vaccine, Extra", vaccineId: null }] }],
      (row) => row.itemName
    );
    const csv = dosesGivenPivotToCsv(commaPivot);
    expect(csv).toContain('"Vaccine, Extra"');
  });
});
