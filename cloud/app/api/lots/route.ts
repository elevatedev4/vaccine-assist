import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * REST endpoint for the desktop app's Lots screen (inventory +
 * expirations). GET lists lots, optionally filtered by ?vaccineId= or
 * ?status=active|depleted. POST creates a lot (used by the Lots screen
 * when staff add a new shipment).
 */
export async function GET(request: Request) {
  try {
    const supabase = getSupabaseServerClient();
    const { searchParams } = new URL(request.url);
    const vaccineId = searchParams.get("vaccineId");
    const status = searchParams.get("status");

    let query = supabase.from("lot").select("*").order("expiration", { ascending: true });
    if (vaccineId) query = query.eq("vaccine_id", vaccineId);
    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ lots: data });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const supabase = getSupabaseServerClient();
    const body = await request.json();

    const { vaccine_id, lot_number, expiration, status, note } = body ?? {};
    if (!vaccine_id || !lot_number || !expiration) {
      return NextResponse.json(
        { error: "vaccine_id, lot_number, and expiration are required." },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from("lot")
      .insert({ vaccine_id, lot_number, expiration, status: status ?? "active", note })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ lot: data }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
