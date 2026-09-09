import { describe, expect, it } from "vitest";
import { buildPocTestTable, computePocTestHeatmapMaxes, type TestCount } from "@/lib/poc-test-table";

describe("buildPocTestTable", () => {
  const days = ["2026-08-17", "2026-08-18", "2026-08-19"];

  it("returns an empty shell (zero columns/rows, zeroed totals) for an empty input", () => {
    const table = buildPocTestTable([], days);

    expect(table).toEqual({
      days,
      columns: [],
      rows: [],
      dailyTotals: { "2026-08-17": 0, "2026-08-18": 0, "2026-08-19": 0 },
      grandTotal: 0,
    });
  });

  it("builds one column/row per distinct test name, sorted alphabetically", () => {
    const testCounts: TestCount[] = [
      { date: "2026-08-17", testName: "Strep Throat", count: 2 },
      { date: "2026-08-17", testName: "COVID", count: 3 },
      { date: "2026-08-18", testName: "COVID", count: 1 },
      { date: "2026-08-19", testName: "Flu", count: 5 },
    ];

    const table = buildPocTestTable(testCounts, days);

    expect(table.columns).toEqual([
      { testName: "COVID", label: "COVID" },
      { testName: "Flu", label: "Flu" },
      { testName: "Strep Throat", label: "Strep Throat" },
    ]);
    expect(table.rows).toEqual([
      { testName: "COVID", countsByDay: { "2026-08-17": 3, "2026-08-18": 1, "2026-08-19": 0 }, total: 4 },
      { testName: "Flu", countsByDay: { "2026-08-17": 0, "2026-08-18": 0, "2026-08-19": 5 }, total: 5 },
      { testName: "Strep Throat", countsByDay: { "2026-08-17": 2, "2026-08-18": 0, "2026-08-19": 0 }, total: 2 },
    ]);
    expect(table.dailyTotals).toEqual({ "2026-08-17": 5, "2026-08-18": 1, "2026-08-19": 5 });
    expect(table.grandTotal).toBe(11);
  });

  it("sums duplicate (date, testName) entries rather than overwriting", () => {
    const testCounts: TestCount[] = [
      { date: "2026-08-17", testName: "COVID", count: 2 },
      { date: "2026-08-17", testName: "COVID", count: 3 },
    ];

    const table = buildPocTestTable(testCounts, days);

    expect(table.rows).toEqual([
      { testName: "COVID", countsByDay: { "2026-08-17": 5, "2026-08-18": 0, "2026-08-19": 0 }, total: 5 },
    ]);
  });

  it("ignores an entry whose date isn't in the requested days (stale-response guard)", () => {
    const testCounts: TestCount[] = [
      { date: "2099-01-01", testName: "COVID", count: 9 },
      { date: "2026-08-17", testName: "COVID", count: 1 },
    ];

    const table = buildPocTestTable(testCounts, days);

    expect(table.grandTotal).toBe(1);
    expect(table.rows[0].total).toBe(1);
  });
});

describe("computePocTestHeatmapMaxes", () => {
  it("returns {0, 0} for an all-empty table", () => {
    const table = buildPocTestTable([], ["2026-08-17"]);

    expect(computePocTestHeatmapMaxes(table)).toEqual({ dataScaleMax: 0, totalScaleMax: 0 });
  });

  it("computes the max per-cell count and the max daily total as independent scales", () => {
    const days = ["2026-08-17", "2026-08-18"];
    const testCounts: TestCount[] = [
      { date: "2026-08-17", testName: "COVID", count: 4 },
      { date: "2026-08-17", testName: "Flu", count: 3 },
      { date: "2026-08-18", testName: "COVID", count: 2 },
    ];
    const table = buildPocTestTable(testCounts, days);

    // dataScaleMax: the single biggest per-(day, test) cell (4, COVID on
    // 8/17). totalScaleMax: the single biggest DAY total (8/17's 4+3=7),
    // not the same number — proves the two scales are independent, same
    // pattern lib/appointment-table.ts's computeHeatmapMaxes tests assert.
    expect(computePocTestHeatmapMaxes(table)).toEqual({ dataScaleMax: 4, totalScaleMax: 7 });
  });
});
