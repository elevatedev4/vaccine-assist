import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { isMissingColumnError } from "@/lib/schema-degradation";

/**
 * REST endpoint for the desktop app's Lots screen (inventory +
 * expirations), also used by the rebuilt web /lots page (V-cloud-tabs,
 * Will 2026-09-05/07: one row per active vaccine, inline-editable lot
 * number/expiration/beyond-use date). GET lists lots, optionally
 * filtered by ?vaccineId= or ?status=active|depleted. POST creates a lot
 * (used both by the Lots screen's "add a shipment" flow and by the /lots
 * page's per-row save when a vaccine has no current active lot yet).
 *
 * `beyond_use_date` is an additive column
 * (supabase/migrations/0009_lots_bud_vaccine_defaults.sql) that may not
 * exist yet on a given database — see lib/schema-degradation.ts. Both
 * GET and POST here try the full column set first and transparently
 * retry without beyond_use_date if Postgres reports it's missing,
 * flagging `beyondUseDateSupported: false` in the response rather than
 * failing outright.
 */
const LOT_COLUMNS_BASE = "id, vaccine_id, lot_number, expiration, status, note, created_at, updated_at";
const LOT_COLUMNS_FULL = `${LOT_COLUMNS_BASE}, beyond_use_date`;

function buildLotsQuery(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  columns: string,
  vaccineId: string | null,
  status: string | null
) {
  let query = supabase.from("lot").select(columns).order("expiration", { ascending: true });
  if (vaccineId) query = query.eq("vaccine_id", vaccineId);
  if (status) query = query.eq("status", status);
  return query;
}

export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  try {
    const supabase = getSupabaseServerClient();
    const { searchParams } = new URL(request.url);
    const vaccineId = searchParams.get("vaccineId");
    const status = searchParams.get("status");

    let { data, error } = await buildLotsQuery(supabase, LOT_COLUMNS_FULL, vaccineId, status);
    let beyondUseDateSupported = true;

    if (error && isMissingColumnError(error)) {
      beyondUseDateSupported = false;
      ({ data, error } = await buildLotsQuery(supabase, LOT_COLUMNS_BASE, vaccineId, status));
    }

    if (error) {
      console.error("GET /api/lots: Supabase error", error);
      return NextResponse.json({ error: "Failed to load lots." }, { status: 500 });
    }

    return NextResponse.json({ lots: data, beyondUseDateSupported });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}

export async function POST(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  try {
    const supabase = getSupabaseServerClient();
    const body = await request.json();

    const { vaccine_id, lot_number, expiration, status, note, beyond_use_date } = body ?? {};
    if (!vaccine_id || !lot_number || !expiration) {
      return NextResponse.json(
        { error: "vaccine_id, lot_number, and expiration are required." },
        { status: 400 }
      );
    }
    if (beyond_use_date !== undefined && beyond_use_date !== null && typeof beyond_use_date !== "string") {
      return NextResponse.json({ error: "beyond_use_date must be a date string or null." }, { status: 400 });
    }

    const insertPayload: Record<string, unknown> = {
      vaccine_id,
      lot_number,
      expiration,
      status: status ?? "active",
      note,
    };
    if (beyond_use_date !== undefined) insertPayload.beyond_use_date = beyond_use_date;

    let { data, error } = await supabase.from("lot").insert(insertPayload).select().single();
    let beyondUseDateSupported = true;

    if (error && isMissingColumnError(error) && "beyond_use_date" in insertPayload) {
      beyondUseDateSupported = false;
      const { beyond_use_date: _bud, ...withoutBud } = insertPayload;
      ({ data, error } = await supabase.from("lot").insert(withoutBud).select().single());
    }

    if (error) {
      console.error("POST /api/lots: Supabase error", error);
      return NextResponse.json({ error: "Failed to create lot." }, { status: 500 });
    }

    return NextResponse.json({ lot: data, beyondUseDateSupported }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
