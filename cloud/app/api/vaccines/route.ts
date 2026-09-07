import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { isMissingColumnError } from "@/lib/schema-degradation";

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
 *
 * V-cloud-tabs (Will, 2026-09-05/07): also selects `quantity`/`directions`
 * (Pioneer prescription-entry defaults, editable on the Active vaccines
 * page) — supabase/migrations/0009_lots_bud_vaccine_defaults.sql. Named
 * explicitly (not `select("*")`) so a database that hasn't run that
 * migration yet can be detected and degraded gracefully: try selecting
 * WITH those columns first, and if Postgres reports they don't exist,
 * retry WITHOUT them and flag `quantityDirectionsSupported: false` in the
 * response so the client can hide those inputs with a "pending
 * migration" note instead of crashing. See lib/schema-degradation.ts.
 */
const VACCINE_COLUMNS_BASE =
  "id, name, ndc, dose, short_code, cash_price_cents, active, created_at, updated_at";
const VACCINE_COLUMNS_FULL = `${VACCINE_COLUMNS_BASE}, quantity, directions`;

export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  const { searchParams } = new URL(request.url);
  const includeInactive = searchParams.get("includeInactive") === "true";

  try {
    const supabase = getSupabaseServerClient();

    if (!includeInactive) {
      // Loosely typed on purpose: the FULL and BASE column-list selects
      // below produce different literal row types (supabase-js infers a
      // type from the select() string), and this variable gets
      // reassigned to whichever one actually succeeded.
      let { data, error }: { data: Record<string, unknown>[] | null; error: { message?: string; code?: string } | null } =
        await supabase.from("vaccine").select(VACCINE_COLUMNS_FULL).eq("active", true).order("name", { ascending: true });
      let quantityDirectionsSupported = true;

      if (error && isMissingColumnError(error)) {
        quantityDirectionsSupported = false;
        ({ data, error } = await supabase
          .from("vaccine")
          .select(VACCINE_COLUMNS_BASE)
          .eq("active", true)
          .order("name", { ascending: true }));
      }

      if (error) {
        console.error("GET /api/vaccines: Supabase error", error);
        return NextResponse.json({ error: "Failed to load vaccines." }, { status: 500 });
      }

      return NextResponse.json({ vaccines: data, quantityDirectionsSupported });
    }

    let vaccinesResult: {
      data: Record<string, unknown>[] | null;
      error: { message?: string; code?: string } | null;
    } = await supabase.from("vaccine").select(VACCINE_COLUMNS_FULL).order("name", { ascending: true });
    let quantityDirectionsSupported = true;
    if (vaccinesResult.error && isMissingColumnError(vaccinesResult.error)) {
      quantityDirectionsSupported = false;
      vaccinesResult = await supabase.from("vaccine").select(VACCINE_COLUMNS_BASE).order("name", { ascending: true });
    }

    const [{ data: vaccines, error: vaccinesError }, { data: activeLots, error: lotsError }] = await Promise.all([
      Promise.resolve(vaccinesResult),
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

    return NextResponse.json({ vaccines: vaccinesWithLotFlag, quantityDirectionsSupported });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
