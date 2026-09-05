import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { evaluateEligibilityRules, type EligibilityRule } from "@/lib/eligibility";
import { requireAuthenticatedUser } from "@/lib/auth";

/**
 * GET ?age=N -> every ACTIVE vaccine whose eligibility rules don't BLOCK
 * age N — status "allowed" or "warning" (same "a warning is staff
 * judgment, not a hard stop" convention DataEntryGate.cs's own doc comment
 * already documents for the desktop side), each returned with its own
 * `eligibility` result attached.
 *
 * Added for the data-entry popup's guided flow (age -> vaccine group ->
 * product -> dose — see DataEntryPopupViewModel): grouping the formulary
 * by common name and filtering to "eligible for THIS age" needs "every
 * eligible vaccine for age N" in one shot. The existing building blocks
 * (GET /api/vaccines for the full active list, POST
 * /api/eligibility/evaluate for one vaccine at a time) can't answer that
 * without N round trips from the desktop app for a ~30-vaccine formulary —
 * this route does the same per-vaccine evaluateEligibilityRules call
 * evaluate/route.ts does, just for every vaccine at once, server-side.
 */
export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  const { searchParams } = new URL(request.url);
  const ageParam = searchParams.get("age");
  const age = ageParam === null ? NaN : Number(ageParam);
  if (ageParam === null || !Number.isFinite(age)) {
    return NextResponse.json({ error: "age (number, query param) is required." }, { status: 400 });
  }

  try {
    const supabase = getSupabaseServerClient();

    const { data: vaccines, error: vaccinesError } = await supabase
      .from("vaccine")
      .select("*")
      .eq("active", true)
      .order("name", { ascending: true });

    if (vaccinesError) {
      console.error("GET /api/eligibility/for-age: Supabase error (vaccines)", vaccinesError);
      return NextResponse.json({ error: "Failed to load vaccines." }, { status: 500 });
    }

    const vaccineIds = (vaccines ?? []).map((vaccine) => vaccine.id);

    const { data: rules, error: rulesError } =
      vaccineIds.length > 0
        ? await supabase.from("eligibility_rule").select("*").in("vaccine_id", vaccineIds)
        : { data: [] as Record<string, unknown>[], error: null };

    if (rulesError) {
      console.error("GET /api/eligibility/for-age: Supabase error (rules)", rulesError);
      return NextResponse.json({ error: "Failed to load eligibility rules." }, { status: 500 });
    }

    const rulesByVaccineId = new Map<string, EligibilityRule[]>();
    for (const row of rules ?? []) {
      const rule: EligibilityRule = {
        vaccineId: row.vaccine_id as string,
        minAge: row.min_age as number | null,
        maxAge: row.max_age as number | null,
        conditionNote: row.condition_note as string | null,
        pregnancyWarning: row.pregnancy_warning as boolean,
        priority: row.priority as number,
      };
      const existing = rulesByVaccineId.get(rule.vaccineId) ?? [];
      existing.push(rule);
      rulesByVaccineId.set(rule.vaccineId, existing);
    }

    const eligibleVaccines = (vaccines ?? [])
      .map((vaccine) => ({
        vaccine,
        eligibility: evaluateEligibilityRules(rulesByVaccineId.get(vaccine.id) ?? [], { ageYears: age }),
      }))
      .filter(({ eligibility }) => eligibility.status !== "blocked")
      .map(({ vaccine, eligibility }) => ({ ...vaccine, eligibility }));

    return NextResponse.json({ vaccines: eligibleVaccines });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
