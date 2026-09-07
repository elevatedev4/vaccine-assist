import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { isMissingColumnError } from "@/lib/schema-degradation";

/**
 * REST endpoint for the desktop app's Physicians settings screen —
 * the vaccine/age-range -> physician assignment rules (see
 * supabase/migrations/0007_physicians.sql). GET lists every rule,
 * optionally filtered to one physician's rules (?physicianId=). POST
 * creates a rule: { physician_id, vaccine_id?, vaccine_group?, min_age?,
 * max_age?, priority? } — vaccine_id AND vaccine_group both
 * omitted/null means "any vaccine" (the wildcard/"everything else"
 * fallback rule).
 *
 * V-cloud-tabs (Will, 2026-09-05/07): `vaccine_group` lets a rule target
 * a whole catalog group (e.g. "Flu") instead of one vaccine — see
 * cloud/lib/physician-resolution.ts's specificity tiers and
 * lib/vaccine-group-catalog.ts. It's mutually exclusive with vaccine_id
 * (validated below) and is an additive column
 * (supabase/migrations/0009_lots_bud_vaccine_defaults.sql) that may not
 * exist yet on a given database — see lib/schema-degradation.ts. GET
 * selects it by name (not `select("*")`) so its absence can be detected
 * and reported via `vaccineGroupSupported` in the response; POST/PATCH
 * retry without it on a missing-column error rather than failing the
 * whole write.
 */
const RULE_COLUMNS_BASE = "id, physician_id, vaccine_id, min_age, max_age, priority, created_at, updated_at";
const RULE_COLUMNS_FULL = `${RULE_COLUMNS_BASE}, vaccine_group`;

export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  try {
    const supabase = getSupabaseServerClient();
    const { searchParams } = new URL(request.url);
    const physicianId = searchParams.get("physicianId");

    function buildQuery(columns: string) {
      let query = supabase.from("physician_rule").select(columns).order("priority", { ascending: true });
      if (physicianId) query = query.eq("physician_id", physicianId);
      return query;
    }

    let { data, error } = await buildQuery(RULE_COLUMNS_FULL);
    let vaccineGroupSupported = true;
    if (error && isMissingColumnError(error)) {
      vaccineGroupSupported = false;
      ({ data, error } = await buildQuery(RULE_COLUMNS_BASE));
    }

    if (error) {
      console.error("GET /api/physician-rules: Supabase error", error);
      return NextResponse.json({ error: "Failed to load physician rules." }, { status: 500 });
    }

    return NextResponse.json({ physicianRules: data, vaccineGroupSupported });
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
    const { physician_id, vaccine_id, vaccine_group, min_age, max_age, priority } = body ?? {};

    if (typeof physician_id !== "string" || !physician_id) {
      return NextResponse.json({ error: "physician_id is required." }, { status: 400 });
    }
    if (vaccine_id !== undefined && vaccine_id !== null && typeof vaccine_id !== "string") {
      return NextResponse.json({ error: "vaccine_id must be a string or null." }, { status: 400 });
    }
    if (vaccine_group !== undefined && vaccine_group !== null && typeof vaccine_group !== "string") {
      return NextResponse.json({ error: "vaccine_group must be a string or null." }, { status: 400 });
    }
    if (vaccine_id && vaccine_group) {
      return NextResponse.json(
        { error: "A rule may target a specific vaccine_id OR a vaccine_group, not both." },
        { status: 400 }
      );
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
    const insertPayload = {
      physician_id,
      vaccine_id: vaccine_id ?? null,
      vaccine_group: vaccine_group ?? null,
      min_age: min_age ?? null,
      max_age: max_age ?? null,
      priority: typeof priority === "number" ? priority : 0,
    };

    let { data, error } = await supabase.from("physician_rule").insert(insertPayload).select().single();
    let vaccineGroupSupported = true;

    if (error && isMissingColumnError(error)) {
      vaccineGroupSupported = false;
      if (insertPayload.vaccine_group !== null) {
        return NextResponse.json(
          { error: "vaccine_group is not available yet — the migration hasn't run.", vaccineGroupSupported },
          { status: 409 }
        );
      }
      const { vaccine_group: _vg, ...withoutVaccineGroup } = insertPayload;
      ({ data, error } = await supabase.from("physician_rule").insert(withoutVaccineGroup).select().single());
    }

    if (error) {
      console.error("POST /api/physician-rules: Supabase error", error);
      return NextResponse.json({ error: "Failed to create physician rule." }, { status: 500 });
    }

    return NextResponse.json({ physicianRule: data, vaccineGroupSupported }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
