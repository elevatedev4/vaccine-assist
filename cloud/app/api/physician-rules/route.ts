import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";

/**
 * REST endpoint for the desktop app's Physicians settings screen —
 * the vaccine/age-range -> physician assignment rules (see
 * supabase/migrations/0007_physicians.sql). GET lists every rule,
 * optionally filtered to one physician's rules (?physicianId=). POST
 * creates a rule: { physician_id, vaccine_id?, min_age?, max_age?,
 * priority? } — vaccine_id omitted/null means "any vaccine" (the
 * wildcard/"everything else" fallback rule).
 */
export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  try {
    const supabase = getSupabaseServerClient();
    const { searchParams } = new URL(request.url);
    const physicianId = searchParams.get("physicianId");

    let query = supabase.from("physician_rule").select("*").order("priority", { ascending: true });
    if (physicianId) query = query.eq("physician_id", physicianId);

    const { data, error } = await query;
    if (error) {
      console.error("GET /api/physician-rules: Supabase error", error);
      return NextResponse.json({ error: "Failed to load physician rules." }, { status: 500 });
    }

    return NextResponse.json({ physicianRules: data });
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
    const body = await request.json();
    const { physician_id, vaccine_id, min_age, max_age, priority } = body ?? {};

    if (typeof physician_id !== "string" || !physician_id) {
      return NextResponse.json({ error: "physician_id is required." }, { status: 400 });
    }
    if (vaccine_id !== undefined && vaccine_id !== null && typeof vaccine_id !== "string") {
      return NextResponse.json({ error: "vaccine_id must be a string or null." }, { status: 400 });
    }
    if (min_age !== undefined && min_age !== null && typeof min_age !== "number") {
      return NextResponse.json({ error: "min_age must be a number or null." }, { status: 400 });
    }
    if (max_age !== undefined && max_age !== null && typeof max_age !== "number") {
      return NextResponse.json({ error: "max_age must be a number or null." }, { status: 400 });
    }
    if (
      min_age !== undefined &&
      min_age !== null &&
      max_age !== undefined &&
      max_age !== null &&
      min_age > max_age
    ) {
      return NextResponse.json({ error: "min_age must not be greater than max_age." }, { status: 400 });
    }

    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("physician_rule")
      .insert({
        physician_id,
        vaccine_id: vaccine_id ?? null,
        min_age: min_age ?? null,
        max_age: max_age ?? null,
        priority: typeof priority === "number" ? priority : 0,
      })
      .select()
      .single();

    if (error) {
      console.error("POST /api/physician-rules: Supabase error", error);
      return NextResponse.json({ error: "Failed to create physician rule." }, { status: 500 });
    }

    return NextResponse.json({ physicianRule: data }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
