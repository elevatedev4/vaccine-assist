import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";

/**
 * REST endpoint for the desktop app's Vaccines screen (what we offer).
 * GET returns the active formulary by default. Phase 1: no Supabase
 * project exists yet, so a misconfigured environment surfaces as a 503
 * rather than a crash at build/import time.
 *
 * ?includeInactive=true switches to the admin/full list used by the
 * desktop Active vaccines tab — every vaccine regardless of `active`,
 * each annotated with `hasActiveLot` (true if `lot` has at least one row
 * for that vaccine with status='active'). This is opt-in and deliberately
 * kept out of the default path: the Lots tab's vaccine dropdown and the
 * Data-entry popup's vaccine dropdown both call GET with no query params
 * and depend on the default staying active-only, unfiltered-lot-free.
 */
export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  const { searchParams } = new URL(request.url);
  const includeInactive = searchParams.get("includeInactive") === "true";

  try {
    const supabase = getSupabaseServerClient();

    if (!includeInactive) {
      const { data, error } = await supabase
        .from("vaccine")
        .select("*")
        .eq("active", true)
        .order("name", { ascending: true });

      if (error) {
        console.error("GET /api/vaccines: Supabase error", error);
        return NextResponse.json({ error: "Failed to load vaccines." }, { status: 500 });
      }

      return NextResponse.json({ vaccines: data });
    }

    const [
      { data: vaccines, error: vaccinesError },
      { data: activeLots, error: lotsError },
    ] = await Promise.all([
      supabase.from("vaccine").select("*").order("name", { ascending: true }),
      supabase.from("lot").select("vaccine_id").eq("status", "active"),
    ]);

    if (vaccinesError || lotsError) {
      console.error("GET /api/vaccines?includeInactive=true: Supabase error", vaccinesError ?? lotsError);
      return NextResponse.json({ error: "Failed to load vaccines." }, { status: 500 });
    }

    const vaccineIdsWithActiveLot = new Set((activeLots ?? []).map((lot) => lot.vaccine_id));
    const vaccinesWithLotFlag = (vaccines ?? []).map((vaccine) => ({
      ...vaccine,
      hasActiveLot: vaccineIdsWithActiveLot.has(vaccine.id),
    }));

    return NextResponse.json({ vaccines: vaccinesWithLotFlag });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
