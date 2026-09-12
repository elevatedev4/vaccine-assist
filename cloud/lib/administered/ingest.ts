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
): Promise<IngestResult & { matched: number }> {
  const parsedRows = parseVaccinationLog(matrix);
  const matchedRows = matchAdministeredRows(parsedRows, catalog);
  const matched = matchedRows.filter((row) => row.vaccineId !== null).length;
  const result = await ingestAdministeredRows(supabase, matchedRows, sourceKey);
  return { ...result, matched };
}
