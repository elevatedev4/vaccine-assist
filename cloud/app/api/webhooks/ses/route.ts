import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { parseOnHandContent } from "@/lib/on-hand-parser";
import type { CatalogVaccine } from "@/lib/vaccine-matching";

/**
 * SES inbound-email webhook — on-hand stock ingestion (V-ordering,
 * 2026-08-19/20).
 *
 * Machine-to-machine inbound webhook, NOT a user-facing endpoint: auth is
 * the shared `x-ses-webhook-secret` header (SES_WEBHOOK_SECRET), exactly
 * as before — no Bearer/requireAuthenticatedUser here.
 *
 * DELIBERATE SCOPE DECISION: full SES->SNS raw-MIME/attachment parsing is
 * out of scope for v1 — Will hasn't configured an SES receipt rule yet,
 * and there's no MIME-parsing dependency in this project. This endpoint
 * instead accepts the POST body as EITHER:
 *   - Content-Type: application/json with { "text": "<on-hand lines>" }
 *     (also accepts { "body": "..." } as an alias key), or
 *   - Content-Type: text/plain (or anything else / no JSON) — the raw
 *     request body text is treated as the content directly.
 * Once Will (or an SES receipt rule + relay) sets up real inbound mail
 * delivery, whatever forwards the message body just needs to hit this
 * same contract — no route changes required for that to start working.
 *
 * The extracted content string is run through lib/on-hand-parser.ts
 * (parseOnHandContent — see that file for the exact expected email
 * format) against the current `vaccine` catalog, and every parsed line
 * (matched AND unmatched — nothing is dropped) is inserted into
 * `on_hand_count` (supabase/migrations/0006_on_hand_counts.sql) in one
 * batch insert.
 */

async function extractContent(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      const body: unknown = await request.json();
      if (body && typeof body === "object") {
        const record = body as Record<string, unknown>;
        if (typeof record.text === "string") return record.text;
        if (typeof record.body === "string") return record.body;
      }
      return "";
    } catch {
      // Malformed JSON despite the declared content-type — treat as empty
      // rather than throwing; the summary response below still tells the
      // caller nothing was ingested.
      return "";
    }
  }

  try {
    return await request.text();
  } catch {
    return "";
  }
}

export async function POST(request: Request) {
  const secret = env.sesWebhookSecret();
  if (secret) {
    const provided = request.headers.get("x-ses-webhook-secret");
    if (provided !== secret) {
      return NextResponse.json({ error: "Invalid webhook secret." }, { status: 401 });
    }
  }

  const content = await extractContent(request);
  if (!content || content.trim().length === 0) {
    return NextResponse.json({ linesTotal: 0, matchedCount: 0, unmatchedCount: 0 });
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
    .select("id, name, short_code");

  if (catalogError) {
    console.error("POST /api/webhooks/ses: failed to load vaccine catalog", catalogError);
    return NextResponse.json({ error: "Failed to load vaccine catalog." }, { status: 500 });
  }

  const catalog: CatalogVaccine[] = catalogData ?? [];
  const parsed = parseOnHandContent(content, catalog);

  if (parsed.length === 0) {
    return NextResponse.json({ linesTotal: 0, matchedCount: 0, unmatchedCount: 0 });
  }

  const rows = parsed.map((line) => ({
    raw_line: line.rawLine,
    vaccine_name_raw: line.vaccineNameRaw,
    quantity: line.quantity,
    vaccine_id: line.vaccineId,
    matched: line.matched,
  }));

  const { error: insertError } = await supabase.from("on_hand_count").insert(rows);
  if (insertError) {
    console.error("POST /api/webhooks/ses: failed to insert on_hand_count rows", insertError);
    return NextResponse.json({ error: "Failed to store on-hand counts." }, { status: 500 });
  }

  const matchedCount = parsed.filter((line) => line.matched).length;
  return NextResponse.json({
    linesTotal: parsed.length,
    matchedCount,
    unmatchedCount: parsed.length - matchedCount,
  });
}
