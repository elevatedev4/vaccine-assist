import { matchPioneerItemName } from "@/lib/on-hand/pioneer-boh";
import type { CatalogVaccine } from "@/lib/vaccine-matching";
import type { VaccinationLogRow } from "@/lib/administered/parse";

/**
 * Matches a vaccination-log row's `itemName` (PioneerRx's per-dose
 * report — lib/administered/parse.ts) against the vaccine catalog USING
 * THE SAME NAME MATCHING the BOH stock report's "Item Name" column falls
 * back to once its NDC cell doesn't resolve anything — see
 * lib/on-hand/pioneer-boh.ts's matchPioneerItemName (Pioneer-specific
 * name aliases, then the shared free-text matcher). The vaccination log
 * carries no NDC column at all, so ONLY the name-matching half applies
 * here — there is no NDC-matching step to reuse.
 */

export type MatchedAdministeredRow = {
  at: string;
  /** The America/Chicago calendar date of `at` — carried straight from
   * VaccinationLogRow.dateLocal (not recomputed here) so
   * lib/administered/store.ts's day-key grouping always matches exactly
   * what the parser decided, rather than re-deriving it from `at` a
   * second time. */
  dateLocal: string;
  itemName: string;
  vaccineId: string | null;
};

/** Matches one row; `vaccineId` is null (not thrown/dropped) for an
 * unrecognized item name — the row is still kept (lib/administered/store.ts
 * persists it with vaccineId: null) so it counts toward `unmatched`
 * rather than silently vanishing. */
export function matchAdministeredRow(row: VaccinationLogRow, catalog: CatalogVaccine[]): MatchedAdministeredRow {
  const matched = matchPioneerItemName(row.itemName, catalog);
  return { at: row.completedAt, dateLocal: row.dateLocal, itemName: row.itemName, vaccineId: matched?.id ?? null };
}

export function matchAdministeredRows(rows: VaccinationLogRow[], catalog: CatalogVaccine[]): MatchedAdministeredRow[] {
  return rows.map((row) => matchAdministeredRow(row, catalog));
}
