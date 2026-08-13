import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * REST endpoint for the desktop app's Vaccines screen (what we offer).
 * GET returns the active formulary. Phase 1: no Supabase project exists
 * yet, so a misconfigured environment surfaces as a 503 rather than a
 * crash at build/import time.
 */
export async function GET() {
  try {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("vaccine")
      .select("*")
      .eq("active", true)
      .order("name", { ascending: true });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ vaccines: data });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
