import { describe, expect, it } from "vitest";
import {
  allRange,
  buildDosesGivenPivot,
  DEFAULT_LOOKBACK_DAYS,
  dosesGivenPivotToCsv,
  formatRangeSummary,
  lastNDaysRange,
  orderProductsByGroup,
  productTotalsDescending,
  productTotalsToCsv,
  quickPickRange,
  resolveDoseProductName,
  thisMonthRange,
  visibleDayRows,
  yesterdayInChicago,
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

// V-doses-given-layout (Will 2026-09-13): default-range and quick-pick
// helpers. Every function takes an explicit `today` override so these
// stay deterministic without faking system time (see each function's own
// doc comment in lib/doses-given.ts).
describe("yesterdayInChicago", () => {
  it("returns the day before the given today", () => {
    expect(yesterdayInChicago("2026-09-13")).toBe("2026-09-12");
  });

  it("crosses a month boundary correctly", () => {
    expect(yesterdayInChicago("2026-09-01")).toBe("2026-08-31");
  });
});

describe("lastNDaysRange", () => {
  it("returns the last N complete days ending yesterday, inclusive", () => {
    expect(lastNDaysRange(7, "2026-09-13")).toEqual({ start: "2026-09-06", end: "2026-09-12" });
  });

  it("uses DEFAULT_LOOKBACK_DAYS (14) as the old fixed-lookback fallback", () => {
    expect(lastNDaysRange(DEFAULT_LOOKBACK_DAYS, "2026-09-13")).toEqual({ start: "2026-08-30", end: "2026-09-12" });
  });
});

describe("thisMonthRange", () => {
  it("spans the 1st of the current month through yesterday", () => {
    expect(thisMonthRange("2026-09-13")).toEqual({ start: "2026-09-01", end: "2026-09-12" });
  });

  it("collapses to a single day when today is the 1st (yesterday is last month)", () => {
    // Today is 2026-09-01, so yesterday (2026-08-31) is in August —
    // "this month" (September) has no complete days yet.
    expect(thisMonthRange("2026-09-01")).toEqual({ start: "2026-08-31", end: "2026-08-31" });
  });
});

describe("allRange", () => {
  it("spans the earliest ingested day through yesterday", () => {
    expect(allRange("2026-08-04", "2026-09-13")).toEqual({ start: "2026-08-04", end: "2026-09-12" });
  });

  it("falls back to the DEFAULT_LOOKBACK_DAYS lookback when nothing has been ingested (earliestDay null)", () => {
    expect(allRange(null, "2026-09-13")).toEqual(lastNDaysRange(DEFAULT_LOOKBACK_DAYS, "2026-09-13"));
  });

  it("never returns an inverted range when earliestDay is somehow after yesterday", () => {
    expect(allRange("2026-09-13", "2026-09-13")).toEqual({ start: "2026-09-12", end: "2026-09-12" });
  });
});

describe("quickPickRange", () => {
  const today = "2026-09-13";

  it("all delegates to allRange", () => {
    expect(quickPickRange("all", "2026-08-04", today)).toEqual(allRange("2026-08-04", today));
  });

  it("last7 delegates to lastNDaysRange(7)", () => {
    expect(quickPickRange("last7", "2026-08-04", today)).toEqual(lastNDaysRange(7, today));
  });

  it("last14 delegates to lastNDaysRange(14)", () => {
    expect(quickPickRange("last14", "2026-08-04", today)).toEqual(lastNDaysRange(14, today));
  });

  it("thisMonth delegates to thisMonthRange", () => {
    expect(quickPickRange("thisMonth", "2026-08-04", today)).toEqual(thisMonthRange(today));
  });
});

describe("orderProductsByGroup", () => {
  it("puts COVID products first, then Flu, then everything else, alphabetical within each group", () => {
    const products = ["Shingrix", "Comirnaty", "Vaqta", "Fluzone", "Boostrix", "Novavax", "Afluria"];
    expect(orderProductsByGroup(products)).toEqual([
      "Comirnaty",
      "Novavax",
      "Afluria",
      "Fluzone",
      "Boostrix",
      "Shingrix",
      "Vaqta",
    ]);
  });

  it("keeps an unrecognized/raw item name in the trailing 'everything else' group", () => {
    expect(orderProductsByGroup(["MYSTERY DOSE", "Comirnaty"])).toEqual(["Comirnaty", "MYSTERY DOSE"]);
  });

  it("handles an empty product list", () => {
    expect(orderProductsByGroup([])).toEqual([]);
  });
});

// V-doses-given (Will 2026-09-13, verbatim: "We're closed on sat/sun, so
// if there is no data on those days, then no need to show them.")
// 2026-09-05 is a Saturday, 2026-09-06 a Sunday, 2026-09-07 a Monday.
describe("visibleDayRows", () => {
  it("hides a Saturday row with 0 doses", () => {
    const rows = [{ date: "2026-09-05", total: 0 }];
    expect(visibleDayRows(rows)).toEqual([]);
  });

  it("keeps a Saturday row that has doses", () => {
    const rows = [{ date: "2026-09-05", total: 2 }];
    expect(visibleDayRows(rows)).toEqual([{ date: "2026-09-05", total: 2 }]);
  });

  it("hides a Sunday row with 0 doses", () => {
    const rows = [{ date: "2026-09-06", total: 0 }];
    expect(visibleDayRows(rows)).toEqual([]);
  });

  it("keeps a weekday (Monday) row even with 0 doses", () => {
    const rows = [{ date: "2026-09-07", total: 0 }];
    expect(visibleDayRows(rows)).toEqual([{ date: "2026-09-07", total: 0 }]);
  });

  it("filters a mixed week, keeping only weekdays and non-zero weekend days", () => {
    const rows = [
      { date: "2026-09-04", total: 3 }, // Friday, has doses
      { date: "2026-09-05", total: 0 }, // Saturday, closed, no doses
      { date: "2026-09-06", total: 1 }, // Sunday, but had a dose
      { date: "2026-09-07", total: 0 }, // Monday, open, no doses
    ];
    expect(visibleDayRows(rows)).toEqual([
      { date: "2026-09-04", total: 3 },
      { date: "2026-09-06", total: 1 },
      { date: "2026-09-07", total: 0 },
    ]);
  });

  it("passes through extra fields on the row unchanged (generic over row shape)", () => {
    const rows = [{ date: "2026-09-07", total: 0, extra: "kept" }];
    expect(visibleDayRows(rows)).toEqual([{ date: "2026-09-07", total: 0, extra: "kept" }]);
  });
});

describe("formatRangeSummary", () => {
  it("formats the grand-total headline with short M/D dates", () => {
    expect(formatRangeSummary(527, "2026-08-04", "2026-09-11")).toBe("527 doses · 8/4–9/11");
  });

  it("uses the singular 'dose' for a total of exactly 1", () => {
    expect(formatRangeSummary(1, "2026-09-01", "2026-09-01")).toBe("1 dose · 9/1–9/1");
  });

  it("uses the plural 'doses' for a total of 0", () => {
    expect(formatRangeSummary(0, "2026-09-01", "2026-09-02")).toBe("0 doses · 9/1–9/2");
  });
});
