import { NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getOrCreateAddressForUser, touchLastReceived } from "@/lib/on-hand/address";
import { extractUploadContent } from "@/lib/on-hand/upload";
import { parseOnHandContent } from "@/lib/on-hand-parser";
import { isMissingTableError } from "@/lib/schema-degradation";
import type { CatalogVaccine } from "@/lib/vaccine-matching";

/**
 * POST /api/on-hand/upload — "give them the option to upload their first
 * data set" (Will's brief, verbatim), for a user who hasn't received any
 * on-hand email yet. Accepts either a multipart/form-data upload (a
 * `file` field — what app/ordering/page.tsx's file input posts) or a raw
 * text/csv body, same on-hand-line format as the email path
 * (lib/on-hand-parser.ts, "VaccineName, Quantity" per line) — one shared
 * parser so email and upload never drift on what counts as valid input.
 *
 * 200 KB cap (brief, see lib/on-hand/upload.ts's MAX_UPLOAD_BYTES)
 * applies to either shape: for multipart, the file's own size; for a raw
 * body, its UTF-8 byte length once read.
 */
export async function POST(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  let content: string;
  try {
    content = await extractUploadContent(request);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not read the uploaded file." },
      { status: 400 }
    );
  }

  if (!content || content.trim().length === 0) {
    return NextResponse.json({ error: "The uploaded file was empty." }, { status: 400 });
  }

  let address;
  try {
    address = await getOrCreateAddressForUser(auth.user.id);
  } catch (err) {
    if (isMissingTableError(err)) {
      return NextResponse.json(
        { error: "On-hand upload isn't available yet (pending database migration)." },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
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

  const { data: catalogData, error: catalogError } = await supabase.from("vaccine").select("id, name, short_code");
  if (catalogError) {
    console.error("POST /api/on-hand/upload: failed to load vaccine catalog", catalogError);
    return NextResponse.json({ error: "Failed to load vaccine catalog." }, { status: 500 });
  }

  const catalog: CatalogVaccine[] = catalogData ?? [];
  const parsed = parseOnHandContent(content, catalog);

  if (parsed.length === 0) {
    return NextResponse.json({ inserted: 0, unmatched: [] });
  }

  const rows = parsed.map((line) => ({
    raw_line: line.rawLine,
    vaccine_name_raw: line.vaccineNameRaw,
    quantity: line.quantity,
    vaccine_id: line.vaccineId,
    matched: line.matched,
    inbound_email_address_id: address.id,
    source: "upload",
  }));

  const { error: insertError } = await supabase.from("on_hand_count").insert(rows);
  if (insertError) {
    console.error("POST /api/on-hand/upload: failed to insert on_hand_count rows", insertError);
    return NextResponse.json({ error: "Failed to store the uploaded on-hand counts." }, { status: 500 });
  }

  await touchLastReceived(address.id);

  const unmatched = parsed.filter((line) => !line.matched).map((line) => line.vaccineNameRaw);
  return NextResponse.json({ inserted: parsed.length, unmatched });
}
