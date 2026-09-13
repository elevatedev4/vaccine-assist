import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { reprocessAdministeredAttachments } from "@/lib/administered/reprocess";

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
 * Authed like every other admin route (requireAuthenticatedUser). The
 * actual attachment-scanning/ingest work lives in
 * lib/administered/reprocess.ts's reprocessAdministeredAttachments,
 * shared with scripts/reprocess-administered.ts so the two callers can
 * never drift on which attachments count as a vaccination log or how
 * they're ingested.
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

  let result;
  try {
    result = await reprocessAdministeredAttachments(supabase);
  } catch (err) {
    console.error("POST /api/administered/reprocess: failed", err);
    return NextResponse.json({ error: "Failed to load vaccine catalog." }, { status: 500 });
  }

  console.log(
    `POST /api/administered/reprocess: processed=${result.processed} rows=${result.rows} matched=${result.matched} days=${result.days} skipped=${result.skipped}`
  );
  return NextResponse.json({
    processed: result.processed,
    rows: result.rows,
    matched: result.matched,
    days: result.days,
    skipped: result.skipped,
  });
}
