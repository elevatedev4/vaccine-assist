import type { getSupabaseServerClient } from "@/lib/supabase/server";
import type { CatalogVaccine } from "@/lib/vaccine-matching";
import { parseVaccinationLog } from "@/lib/administered/parse";
import { matchAdministeredRows } from "@/lib/administered/match";
import { ingestAdministeredRows, type IngestResult } from "@/lib/administered/store";

/**
 * Single entry point both the SES webhook (app/api/webhooks/ses/route.ts,
 * right after a vaccination-log attachment is retained) and
 * POST /api/administered/reprocess funnel a vaccination-log matrix
 * through: parse -> match -> store. Kept as one function so the two
 * callers can never drift on the parse/match/store order.
 */
export async function ingestVaccinationLogMatrix(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  matrix: unknown[][],
  catalog: CatalogVaccine[],
  sourceKey: string
): Promise<IngestResult & { matched: number; skipped: number }> {
  const { rows: parsedRows, skipped, skippedSamples } = parseVaccinationLog(matrix);
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
  const result = await ingestAdministeredRows(supabase, matchedRows, sourceKey);
  return { ...result, matched, skipped };
}
