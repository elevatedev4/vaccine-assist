import type { getSupabaseServerClient } from "@/lib/supabase/server";
import {
  getInboundAttachmentByKey,
  headerInfoFromMatrix,
  isVaccinationLogHeaderLine,
  listInboundAttachments,
  matrixFromDelimitedText,
  matrixFromXlsxBuffer,
} from "@/lib/inbound-attachments";
import { ingestVaccinationLogMatrix } from "@/lib/administered/ingest";
import type { CatalogVaccine } from "@/lib/vaccine-matching";

const XLSX_PATTERN = /spreadsheet|vnd\.ms-excel|\.xlsx$/i;

export type ReprocessAttachmentInfo = {
  key: string;
  filename: string;
  receivedAt: string;
};

export type ReprocessResult = {
  processed: number;
  rows: number;
  matched: number;
  days: number;
  skipped: number;
  /** Every retained attachment recognized as a vaccination log (its
   * header row passed isVaccinationLogHeaderLine) — present whether or
   * not it was actually ingested (see `dryRun`). */
  attachments: ReprocessAttachmentInfo[];
};

export type ReprocessOptions = {
  /** true: only identifies which retained attachments look like a
   * vaccination log — never calls ingestVaccinationLogMatrix, so
   * nothing is written. processed/rows/matched/days/skipped stay 0;
   * `attachments` still lists what WOULD be processed. */
  dryRun?: boolean;
};

/**
 * Shared core behind POST /api/administered/reprocess
 * (app/api/administered/reprocess/route.ts) and
 * scripts/reprocess-administered.ts. Re-reads every retained inbound
 * attachment (lib/inbound-attachments.ts), finds the ones whose header
 * row is a vaccination log (isVaccinationLogHeaderLine — the same check
 * the SES webhook uses to detect the report in the first place), and —
 * unless `options.dryRun` — ingests each one through the same
 * parse -> match -> store path (lib/administered/ingest.ts).
 * IDEMPOTENT: lib/administered/store.ts's mergeRows dedupes by
 * (at, itemName), so reprocessing an attachment already ingested by the
 * webhook — or reprocessing twice — never double-counts a dose.
 *
 * Kept as one function (not duplicated between the route and the
 * script) so the two callers can never drift on which attachments count
 * as a vaccination log or how they're ingested. Throws on a genuine
 * Supabase error loading the vaccine catalog — callers decide how to
 * surface that (the route as a 500, the script by letting it crash with
 * a stack trace).
 */
export async function reprocessAdministeredAttachments(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  options: ReprocessOptions = {}
): Promise<ReprocessResult> {
  const { dryRun = false } = options;

  const { data: vaccineRows, error: catalogError } = await supabase
    .from("vaccine")
    .select("id, name, short_code, ndc");
  if (catalogError) {
    throw new Error(`Failed to load vaccine catalog: ${catalogError.message ?? String(catalogError)}`);
  }
  const catalog: CatalogVaccine[] = vaccineRows ?? [];

  const attachmentMetas = await listInboundAttachments(supabase);

  let processed = 0;
  let rows = 0;
  let matched = 0;
  let skipped = 0;
  const daysTouched = new Set<string>();
  const attachments: ReprocessAttachmentInfo[] = [];

  for (const meta of attachmentMetas) {
    const attachment = await getInboundAttachmentByKey(supabase, meta.key);
    if (!attachment) continue;

    const buffer = Buffer.from(attachment.base64, "base64");
    let matrix: unknown[][];
    try {
      matrix =
        XLSX_PATTERN.test(attachment.contentType) || XLSX_PATTERN.test(attachment.filename)
          ? matrixFromXlsxBuffer(buffer)
          : matrixFromDelimitedText(buffer.toString("utf-8"), buffer.toString("utf-8").includes("\t") ? "\t" : ",");
    } catch (err) {
      console.warn(`reprocessAdministeredAttachments: failed to read attachment key=${meta.key}`, err);
      continue;
    }

    const info = headerInfoFromMatrix(matrix);
    if (!info || !isVaccinationLogHeaderLine(info.headerLine)) continue;

    attachments.push({ key: meta.key, filename: attachment.filename, receivedAt: attachment.receivedAt });
    if (dryRun) continue;

    try {
      const result = await ingestVaccinationLogMatrix(supabase, matrix, catalog, meta.key);
      processed += 1;
      rows += result.rows;
      matched += result.matched;
      skipped += result.skipped;
      for (const day of result.days) daysTouched.add(day);
    } catch (err) {
      console.error(`reprocessAdministeredAttachments: ingest failed for key=${meta.key}`, err);
    }
  }

  return { processed, rows, matched, days: daysTouched.size, skipped, attachments };
}
