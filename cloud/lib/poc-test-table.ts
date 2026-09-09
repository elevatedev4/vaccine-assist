/**
 * Pure, client-safe helper that reshapes the poll route's flat
 * {date, testName, count} list (see TestCount in lib/acuity-client.ts —
 * which is `server-only`, so this file re-declares the shape locally, same
 * convention lib/appointment-table.ts already uses for VaccineCount/
 * HourlyCount) into a test-type-columns x day-rows table for
 * app/appointments/page.tsx's point-of-care testing table (V-T-poc-testing,
 * Will 2026-09-08: "Add a point of care testing appointment table too that
 * shows daily totals for each type of test that is scheduled. Add it below
 * to the right of the vaccine appointment table.").
 *
 * Deliberately SIMPLER than lib/appointment-table.ts's buildAppointmentTable:
 * there is no fixed column set here (Flu/COVID/Common/Other) — the exact
 * tests offered (e.g. "Flu", "COVID", "Strep Throat") are account-specific
 * and read straight off the intake form (see acuity-client.ts's
 * isTestFormFieldName), so columns are discovered dynamically from
 * whatever `testName`s actually appear, sorted alphabetically for a
 * deterministic (if arbitrary) order — same tie-break rule
 * buildAppointmentTable uses for its own "extra" columns. No PHI ever
 * reaches this function — it only ever sees the already-aggregated counts
 * the poll route returns, never raw appointment data.
 */

export type TestCount = {
  date: string;
  testName: string;
  count: number;
};

export type PocTestTableColumn = {
  testName: string;
  label: string;
};

export type PocTestTableRow = {
  testName: string;
  countsByDay: Record<string, number>;
  total: number;
};

export type PocTestTable = {
  days: string[];
  columns: PocTestTableColumn[];
  rows: PocTestTableRow[];
  dailyTotals: Record<string, number>;
  grandTotal: number;
};

/**
 * `days` is the caller's canonical list of "YYYY-MM-DD" column headers —
 * same convention as buildAppointmentTable: every day is pre-seeded with 0
 * for the daily-totals row (and for every discovered test-name row) so a
 * day with nothing scheduled still renders a 0 cell instead of being
 * omitted. An empty `testCounts` list (no point-of-care testing
 * appointments in range) yields zero columns/rows, not an error — the page
 * still renders the table shell with just the Total column, all zero.
 *
 * Any count entry whose `date` isn't in `days` is ignored, same stale-
 * response guard as buildAppointmentTable.
 */
export function buildPocTestTable(testCounts: TestCount[], days: string[]): PocTestTable {
  const zeroedByDay = (): Record<string, number> => Object.fromEntries(days.map((day) => [day, 0]));

  const rowsById = new Map<string, PocTestTableRow>();
  const dailyTotals = zeroedByDay();
  let grandTotal = 0;

  for (const entry of testCounts) {
    if (!(entry.date in dailyTotals)) continue;

    let row = rowsById.get(entry.testName);
    if (!row) {
      row = { testName: entry.testName, countsByDay: zeroedByDay(), total: 0 };
      rowsById.set(entry.testName, row);
    }

    row.countsByDay[entry.date] += entry.count;
    row.total += entry.count;
    dailyTotals[entry.date] += entry.count;
    grandTotal += entry.count;
  }

  const orderedIds = Array.from(rowsById.keys()).sort((a, b) => a.localeCompare(b));
  const rows = orderedIds.map((id) => rowsById.get(id)!);
  const columns = orderedIds.map((id) => ({ testName: id, label: id }));

  return { days, columns, rows, dailyTotals, grandTotal };
}

export type PocTestHeatmapMaxes = {
  /** Max single-cell per-test-type count across every day/test-type cell —
   * same "own independent scale" pattern as
   * lib/appointment-table.ts's computeHeatmapMaxes. */
  dataScaleMax: number;
  /** Max daily TOTAL (dailyTotals) across the table's days — its own
   * scale, same rationale as computeHeatmapMaxes's totalsScaleMax (a
   * day's total is a sum across every test type, roughly an order of
   * magnitude bigger than any single cell). */
  totalScaleMax: number;
};

/** All-zero input (no data yet, or a genuinely empty table) returns
 * {0, 0} — callers pass that straight into heatmapCellBackground
 * (lib/appointment-table.ts), whose own `max <= 0` guard already renders
 * plain white for exactly this case. */
export function computePocTestHeatmapMaxes(table: PocTestTable): PocTestHeatmapMaxes {
  let dataScaleMax = 0;
  for (const row of table.rows) {
    for (const day of table.days) {
      dataScaleMax = Math.max(dataScaleMax, row.countsByDay[day] ?? 0);
    }
  }

  let totalScaleMax = 0;
  for (const day of table.days) {
    totalScaleMax = Math.max(totalScaleMax, table.dailyTotals[day] ?? 0);
  }

  return { dataScaleMax, totalScaleMax };
}
