import { NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getOrCreateAddressForUser } from "@/lib/on-hand/address";
import { extractUploadPayload } from "@/lib/on-hand/upload";
import { insertOnHandRows } from "@/lib/on-hand/insert";
import { matchPioneerBohRows, parseOnHandUpload, type MatchedOnHandRow } from "@/lib/on-hand/pioneer-boh";
import { parsePioneerBohPdf } from "@/lib/on-hand/pioneer-boh-pdf";
import { isMissingTableError } from "@/lib/schema-degradation";
import type { CatalogVaccine } from "@/lib/vaccine-matching";

/**
 * POST /api/on-hand/upload — "give them the option to upload their first
 * data set" (Will's brief, verbatim), for a user who hasn't received any
 * on-hand email yet. Accepts either a multipart/form-data upload (a
 * `file` field — what app/ordering/page.tsx's file input posts) or a raw
 * text/csv body. Four input shapes:
 *   - an xlsx file (Pioneer's real BOH export)
 *   - a Pioneer-shaped csv/tsv (same columns as the xlsx)
 *   - a PDF export of the same table (V-boh-pdf-attachment, 2026-09-09
 *     — PioneerRx's real scheduled email attaches exactly this; a
 *     manually uploaded copy parses identically via
 *     lib/on-hand/pioneer-boh-pdf.ts's parsePioneerBohPdf, handled
 *     directly below since that path is async, unlike the other three)
 *   - the original hand-typed "VaccineName, Quantity" lines
 * xlsx/csv/text share one entry point (lib/on-hand/pioneer-boh.ts's
 * parseOnHandUpload) so email and upload never drift on what counts as
 * valid input.
 *
 * 2 MB cap (V-ordering-targets, raised from 200 KB for xlsx — see
 * lib/on-hand/upload.ts's MAX_UPLOAD_BYTES) applies to either shape.
 *
 * V-ordering-targets (Will 2026-09-08): this route now WORKS even when
 * supabase/migrations/0010_inbound_email_address.sql hasn't been applied
 * yet (previously a 503) — getOrCreateAddressForUser's "table doesn't
 * exist" failure just means addressId stays null, and every inserted row
 * falls back to the pre-0010 shape (no inbound_email_address_id/source),
 * exactly like a legacy row. Only a genuine misconfiguration (Supabase
 * itself unreachable) still 503s. This is what lets the Ordering tab's
 * upload button work today, before either 0010 or 0011 has run.
 */
export async function POST(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  let payload;
  try {
    payload = await extractUploadPayload(request);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not read the uploaded file." },
      { status: 400 }
    );
  }

  if (payload.kind === "text" && (!payload.text || payload.text.trim().length === 0)) {
    return NextResponse.json({ error: "The uploaded file was empty." }, { status: 400 });
  }

  let addressId: string | null = null;
  try {
    addressId = (await getOrCreateAddressForUser(auth.user.id)).id;
  } catch (err) {
    if (!isMissingTableError(err)) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Supabase is not configured." },
        { status: 503 }
      );
    }
    // 0010 hasn't been applied to this environment yet — proceed
    // unscoped, same "legacy, unattributed" posture as an on_hand_count
    // row from before this feature existed.
    addressId = null;
  }

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }

  const { data: catalogData, error: catalogError } = await supabase
    .from("vaccine")
    .select("id, name, short_code, ndc");
  if (catalogError) {
    console.error("POST /api/on-hand/upload: failed to load vaccine catalog", catalogError);
    return NextResponse.json({ error: "Failed to load vaccine catalog." }, { status: 500 });
  }

  const catalog: CatalogVaccine[] = catalogData ?? [];

  let parsed: MatchedOnHandRow[];
  if (payload.kind === "pdf") {
    const pdfResult = await parsePioneerBohPdf(payload.buffer);
    if (!pdfResult) {
      return NextResponse.json({ error: "Could not read the uploaded PDF." }, { status: 400 });
    }
    console.log(
      `POST /api/on-hand/upload: pdf parsed pages=${pdfResult.pages} rows=${pdfResult.rows.length} headerFound=${pdfResult.headerFound}`
    );
    parsed = matchPioneerBohRows(pdfResult.rows, catalog);
  } else {
    parsed = parseOnHandUpload(payload, catalog);
  }

  if (parsed.length === 0) {
    return NextResponse.json({ inserted: 0, unmatched: [] });
  }

  const { error: insertError } = await insertOnHandRows(supabase, parsed, { addressId, source: "upload" }, catalog);
  if (insertError) {
    console.error("POST /api/on-hand/upload: failed to insert on_hand_count rows", insertError);
    return NextResponse.json({ error: "Failed to store the uploaded on-hand counts." }, { status: 500 });
  }

  // Deliberately does NOT call touchLastReceived here (V-ordering-targets
  // review correction, Will's V-T25 answer): GET /api/on-hand/address's
  // `lastReceivedAt` now drives whether the Ordering page's "set up your
  // daily email" popup shows, and that decision must reflect an actual
  // EMAIL received (see app/api/webhooks/ses/route.ts, the only other
  // caller), never a manual upload — an account that's only ever
  // uploaded a file should still see the popup nudging it toward the
  // real automated path.

  const unmatched = parsed.filter((line) => !line.matched).map((line) => line.vaccineNameRaw);
  return NextResponse.json({ inserted: parsed.length, unmatched });
}
