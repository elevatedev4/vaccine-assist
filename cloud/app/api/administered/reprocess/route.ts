import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";
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

/**
 * POST /api/administered/reprocess — re-parses EVERY retained inbound
 * attachment (lib/inbound-attachments.ts) whose header row contains
 * "Completed date" (the same isVaccinationLogHeaderLine check the SES
 * webhook uses to detect the report in the first place) and ingests it
 * through the same parse -> match -> store path
 * (lib/administered/ingest.ts). IDEMPOTENT: lib/administered/store.ts's
 * mergeRows dedupes by (at, itemName), so reprocessing an attachment
 * already ingested by the webhook — or reprocessing twice — never
 * double-counts a dose. This exists for Will to run once after this
 * feature deploys, to load the 08:01Z 2026-09-12 file the webhook
 * retained but (before this feature existed) never ingested; it's safe
 * to run again any time.
 *
 * Authed like every other admin route (requireAuthenticatedUser).
 */
export async function POST(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }

  const { data: vaccineRows, error: catalogError } = await supabase.from("vaccine").select("id, name, short_code, ndc");
  if (catalogError) {
    console.error("POST /api/administered/reprocess: failed to load vaccine catalog", catalogError);
    return NextResponse.json({ error: "Failed to load vaccine catalog." }, { status: 500 });
  }
  const catalog: CatalogVaccine[] = vaccineRows ?? [];

  const attachmentMetas = await listInboundAttachments(supabase);

  let processed = 0;
  let rows = 0;
  let matched = 0;
  const daysTouched = new Set<string>();

  for (const meta of attachmentMetas) {
    const attachment = await getInboundAttachmentByKey(supabase, meta.key);
    if (!attachment) continue;

    const buffer = Buffer.from(attachment.base64, "base64");
    let matrix: unknown[][];
    try {
      matrix = XLSX_PATTERN.test(attachment.contentType) || XLSX_PATTERN.test(attachment.filename)
        ? matrixFromXlsxBuffer(buffer)
        : matrixFromDelimitedText(buffer.toString("utf-8"), buffer.toString("utf-8").includes("\t") ? "\t" : ",");
    } catch (err) {
      console.warn(`POST /api/administered/reprocess: failed to read attachment key=${meta.key}`, err);
      continue;
    }

    const info = headerInfoFromMatrix(matrix);
    if (!info || !isVaccinationLogHeaderLine(info.headerLine)) continue;

    try {
      const result = await ingestVaccinationLogMatrix(supabase, matrix, catalog, meta.key);
      processed += 1;
      rows += result.rows;
      matched += result.matched;
      for (const day of result.days) daysTouched.add(day);
    } catch (err) {
      console.error(`POST /api/administered/reprocess: ingest failed for key=${meta.key}`, err);
    }
  }

  console.log(
    `POST /api/administered/reprocess: processed=${processed} rows=${rows} matched=${matched} days=${daysTouched.size}`
  );
  return NextResponse.json({ processed, rows, matched, days: daysTouched.size });
}
