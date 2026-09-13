import type { VaccinationLogRow } from "@/lib/administered/parse";
import type { MatchedAdministeredRow } from "@/lib/administered/match";

/**
 * Pure summary helpers for a parsed vaccination-log file
 * (scripts/import-doses-file.ts, V-import-doses-file) — deliberately
 * split out of the script itself (which needs env vars + a live
 * Supabase client to load the vaccine catalog) so the parse-only numbers
 * — row count, date range, rows per day — can be computed and unit
 * tested with NO env/catalog/network dependency at all. `unmatchedItemNames`
 * is the one piece that DOES need a matched catalog, so it's kept here
 * as a separate, still-pure function operating on already-matched rows.
 */

export type VaccinationLogSummary = {
  rowCount: number;
  /** Inclusive min/max of every row's `dateLocal` (America/Chicago
   * calendar date, "YYYY-MM-DD") — null only when `rows` is empty. */
  dateRange: { min: string; max: string } | null;
  /** Row count per `dateLocal`, iterated/keyed in ascending date order
   * (a plain object retains insertion order for string keys, so
   * Object.entries(...) below reflects that order without a second
   * sort). */
  perDay: Record<string, number>;
};

export function summarizeVaccinationLogRows(rows: VaccinationLogRow[]): VaccinationLogSummary {
  if (rows.length === 0) return { rowCount: 0, dateRange: null, perDay: {} };

  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.dateLocal, (counts.get(row.dateLocal) ?? 0) + 1);
  }

  const dates = [...counts.keys()].sort();
  const perDay: Record<string, number> = {};
  for (const date of dates) perDay[date] = counts.get(date)!;

  return {
    rowCount: rows.length,
    dateRange: { min: dates[0], max: dates[dates.length - 1] },
    perDay,
  };
}

/** Distinct `itemName`s among `matchedRows` whose `vaccineId` is null
 * (matchAdministeredRows couldn't resolve them against the catalog),
 * alphabetically sorted for stable script output. */
export function unmatchedItemNames(matchedRows: MatchedAdministeredRow[]): string[] {
  const names = new Set<string>();
  for (const row of matchedRows) {
    if (row.vaccineId === null) names.add(row.itemName);
  }
  return [...names].sort();
}
