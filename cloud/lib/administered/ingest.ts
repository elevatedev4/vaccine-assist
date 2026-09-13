import type { getSupabaseServerClient } from "@/lib/supabase/server";
import type { CatalogVaccine } from "@/lib/vaccine-matching";
import { parseVaccinationLog } from "@/lib/administered/parse";
import { matchAdministeredRows, type MatchedAdministeredRow } from "@/lib/administered/match";
import { ingestAdministeredRows, type IngestResult } from "@/lib/administered/store";

/**
 * Single entry point both the SES webhook (app/api/webhooks/ses/route.ts,
 * right after a vaccination-log attachment is retained) and
 * POST /api/administered/reprocess funnel a vaccination-log matrix
 * through: parse -> match -> store. Kept as one function so the two
 * callers can never drift on the parse/match/store order.
 *
 * NON-VACCINE ROWS + DOSE EXPANSION (V-administered-ndc-match,
 * 2026-09-13): resolveRowsToStore below is where matching's per-row
 * output turns into the final list store.ts persists — store.ts itself
 * is unchanged and unaware of any of this, it just receives the already
 * filtered/expanded list, exactly as it always received parse.ts's
 * already-expanded list before this change.
 *
 *   - A row that matched a vaccine (vaccineId set) is expanded into
 *     `doseCount` identical stored rows (moved here from parse.ts —
 *     see parse.ts's top doc comment for why: parse.ts has no catalog,
 *     so it can't tell a real vaccine batch line from a non-vaccine
 *     KPI-export fill that merely happens to carry a large integer
 *     quantity).
 *   - A row that DIDN'T match (vaccineId null) is either:
 *       - DROPPED, counted in `nonVaccineRows`, when the source file
 *         carried an NDC column (parse.ts's `hasNdcColumn`) — that shape
 *         is the KPI-style export, which logs EVERY pharmacy fill, so an
 *         unmatched row there is just a non-vaccine fill, never stored,
 *         never expanded even if it has a large quantity.
 *       - KEPT (unexpanded, `doseCount` ignored), exactly like before
 *         this change, when the file has no NDC column — the classic
 *         2/3-column vaccination log carries only vaccinations, so an
 *         unmatched row there is a genuinely new/unrecognized vaccine
 *         name that must still surface via the existing `unmatched`
 *         summary accounting, not vanish.
 */
function resolveRowsToStore(
  matchedRows: MatchedAdministeredRow[],
  hasNdcColumn: boolean
): { rowsToStore: MatchedAdministeredRow[]; nonVaccineRows: number; expanded: number } {
  const rowsToStore: MatchedAdministeredRow[] = [];
  let nonVaccineRows = 0;
  let expanded = 0;

  for (const row of matchedRows) {
    if (row.vaccineId === null) {
      if (hasNdcColumn) {
        nonVaccineRows += 1;
        continue;
      }
      rowsToStore.push(row);
      continue;
    }

    const doseCount = row.doseCount ?? 1;
    if (doseCount > 1) expanded += 1;
    for (let i = 0; i < doseCount; i++) rowsToStore.push(row);
  }

  return { rowsToStore, nonVaccineRows, expanded };
}

export async function ingestVaccinationLogMatrix(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  matrix: unknown[][],
  catalog: CatalogVaccine[],
  sourceKey: string
): Promise<IngestResult & { matched: number; skipped: number; nonVaccineRows: number; expanded: number }> {
  const { rows: parsedRows, skipped, skippedSamples, hasNdcColumn } = parseVaccinationLog(matrix);
  if (skipped > 0) {
    // Review fix (2026-09-12): these rows were previously dropped
    // silently. Logged once per ingest call, never per row — a ragged
    // file could otherwise flood the log. Only date+item strings are
    // logged (see parse.ts's SkippedVaccinationLogRow) — this report
    // carries no patient data, but the restraint is kept anyway.
    console.warn(
      `ingestVaccinationLogMatrix: skipped ${skipped} row(s) with an unparseable date or blank item name`,
      skippedSamples
    );
  }
  const matchedRows = matchAdministeredRows(parsedRows, catalog);
  const matched = matchedRows.filter((row) => row.vaccineId !== null).length;
  const { rowsToStore, nonVaccineRows, expanded } = resolveRowsToStore(matchedRows, hasNdcColumn);
  if (nonVaccineRows > 0) {
    // Count only, per this file's top doc comment — never the item
    // names (a KPI export's non-vaccine fills are the very Rx data this
    // app must not log).
    console.warn(`ingestVaccinationLogMatrix: dropped ${nonVaccineRows} non-vaccine row(s) from an NDC-column export`);
  }
  if (expanded > 0) {
    // V-import-doses-file, 2026-09-13: a "Dispensed Quantity" column
    // with an integer > 1 expands one MATCHED source row into that many
    // dose rows (parse.ts's doseCountFromQuantityCell) — logged once per
    // ingest call, mirroring `skipped` above, never per row.
    console.warn(`ingestVaccinationLogMatrix: expanded ${expanded} row(s) with an integer quantity > 1 into multiple dose rows`);
  }
  const result = await ingestAdministeredRows(supabase, rowsToStore, sourceKey);
  return { ...result, matched, skipped, nonVaccineRows, expanded };
}
