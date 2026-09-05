import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { resolvePhysician, type Physician, type PhysicianRule } from "@/lib/physician-resolution";
import { requireAuthenticatedUser } from "@/lib/auth";

/** Postgres `uuid` shape, version-agnostic — matches gen_random_uuid() output
 * (used by every id column in this schema, see supabase/migrations/0001_init.sql)
 * as well as any other valid UUID. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET ?vaccineId=&ageYears= -> the protocol physician the data-entry
 * popup should type into PioneerRx's prescriber field for this
 * vaccine/age combination, or { physician: null } when no rule matches
 * (the desktop app blocks "Enter into Pioneer" and points staff at the
 * Physicians settings tab in that case — see
 * DataEntryPopupViewModel.BuildPayloadAsync).
 *
 * Loads every rule that could possibly apply (this exact vaccine, OR a
 * wildcard vaccine_id=null rule) plus every physician, then resolves
 * in-app via cloud/lib/physician-resolution.ts — same "fetch the
 * relevant rows, evaluate in TypeScript" shape as
 * app/api/eligibility/evaluate/route.ts rather than trying to express
 * the specificity-then-priority tie-break as a single SQL query.
 *
 * SECURITY (review fix): vaccineId is validated as a UUID BEFORE it ever
 * reaches Supabase, and the two "this vaccine OR wildcard" halves are
 * fetched as two separate PARAMETERIZED calls (.eq / .is) merged in JS —
 * same convention app/api/eligibility/evaluate/route.ts already uses for
 * vaccineId (.eq("vaccine_id", vaccineId), never raw-interpolated).
 * Originally this used a single `.or(`vaccine_id.eq.${vaccineId},vaccine_id.is.null`)`
 * call: PostgREST's `.or()` takes a raw filter STRING it parses itself
 * (commas separate clauses), so an unvalidated vaccineId containing a
 * comma could inject an extra clause into the filter — e.g.
 * `?vaccineId=x,priority.gt.-999999` would have broadened the rule set
 * returned. The UUID format check alone would already block that
 * (a comma can never appear in a valid UUID), but the .or() call is
 * still removed entirely rather than just gated behind the check, so no
 * future edit to this route can reintroduce the same class of bug by
 * loosening the validation.
 */
export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  const { searchParams } = new URL(request.url);
  const vaccineId = searchParams.get("vaccineId");
  const ageParam = searchParams.get("ageYears");
  const ageYears = ageParam === null ? NaN : Number(ageParam);

  if (!vaccineId) {
    return NextResponse.json({ error: "vaccineId (query param) is required." }, { status: 400 });
  }
  if (!UUID_PATTERN.test(vaccineId)) {
    return NextResponse.json({ error: "vaccineId must be a valid UUID." }, { status: 400 });
  }
  if (ageParam === null || !Number.isFinite(ageYears)) {
    return NextResponse.json({ error: "ageYears (number, query param) is required." }, { status: 400 });
  }

  try {
    const supabase = getSupabaseServerClient();

    const [
      { data: vaccineRuleRows, error: vaccineRulesError },
      { data: wildcardRuleRows, error: wildcardRulesError },
      { data: physicianRows, error: physiciansError },
    ] = await Promise.all([
      supabase.from("physician_rule").select("*").eq("vaccine_id", vaccineId),
      supabase.from("physician_rule").select("*").is("vaccine_id", null),
      supabase.from("physician").select("*"),
    ]);

    const rulesError = vaccineRulesError ?? wildcardRulesError;
    if (rulesError || physiciansError) {
      console.error("GET /api/physicians/resolve: Supabase error", rulesError ?? physiciansError);
      return NextResponse.json({ error: "Failed to load physician rules." }, { status: 500 });
    }

    const rows = [...(vaccineRuleRows ?? []), ...(wildcardRuleRows ?? [])];

    const rules: PhysicianRule[] = rows.map((row) => ({
      id: row.id,
      physicianId: row.physician_id,
      vaccineId: row.vaccine_id,
      minAge: row.min_age,
      maxAge: row.max_age,
      priority: row.priority,
    }));

    const physicians: Physician[] = (physicianRows ?? []).map((row) => ({
      id: row.id,
      displayName: row.display_name,
      alternateId: row.alternate_id,
    }));

    const resolved = resolvePhysician(rules, physicians, { vaccineId, ageYears });

    return NextResponse.json({
      physician: resolved
        ? { id: resolved.id, display_name: resolved.displayName, alternate_id: resolved.alternateId }
        : null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
