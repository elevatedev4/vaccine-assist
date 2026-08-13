import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { evaluateEligibilityRules, type EligibilityRule } from "@/lib/eligibility";

interface EvaluateRequestBody {
  vaccineId: string;
  ageYears: number;
  isPregnant?: boolean;
}

/**
 * POST { vaccineId, ageYears, isPregnant? } -> eligibility result.
 * Replaces the 24 age/eligibility CASE blocks from vaccine-add-new.mxe:
 * the desktop Entry screen calls this before generating the
 * code,lot,exp payload, instead of relying on a staff member's own
 * mental math + the old macro's hardcoded gates.
 */
export async function POST(request: Request) {
  let body: EvaluateRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { vaccineId, ageYears, isPregnant } = body;
  if (!vaccineId || typeof ageYears !== "number" || Number.isNaN(ageYears)) {
    return NextResponse.json(
      { error: "vaccineId (string) and ageYears (number) are required." },
      { status: 400 }
    );
  }

  try {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("eligibility_rule")
      .select("*")
      .eq("vaccine_id", vaccineId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const rules: EligibilityRule[] = (data ?? []).map((row) => ({
      vaccineId: row.vaccine_id,
      minAge: row.min_age,
      maxAge: row.max_age,
      conditionNote: row.condition_note,
      pregnancyWarning: row.pregnancy_warning,
      priority: row.priority,
    }));

    const result = evaluateEligibilityRules(rules, { ageYears, isPregnant });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
