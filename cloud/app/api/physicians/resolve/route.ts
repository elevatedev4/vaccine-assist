import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { resolvePhysician, type Physician, type PhysicianRule } from "@/lib/physician-resolution";
import { requireAuthenticatedUser } from "@/lib/auth";

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
  if (ageParam === null || !Number.isFinite(ageYears)) {
    return NextResponse.json({ error: "ageYears (number, query param) is required." }, { status: 400 });
  }

  try {
    const supabase = getSupabaseServerClient();

    const [{ data: rows, error: rulesError }, { data: physicianRows, error: physiciansError }] =
      await Promise.all([
        supabase.from("physician_rule").select("*").or(`vaccine_id.eq.${vaccineId},vaccine_id.is.null`),
        supabase.from("physician").select("*"),
      ]);

    if (rulesError || physiciansError) {
      console.error("GET /api/physicians/resolve: Supabase error", rulesError ?? physiciansError);
      return NextResponse.json({ error: "Failed to load physician rules." }, { status: 500 });
    }

    const rules: PhysicianRule[] = (rows ?? []).map((row) => ({
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
