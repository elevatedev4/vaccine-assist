import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { isMissingColumnError } from "@/lib/schema-degradation";
import { formatNdcForStorage } from "@/lib/ndc";

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

/**
 * POST /api/vaccines — creates one vaccine row (V-T-ordering-lots-round4,
 * Will: Abrysvo's 1-count product needs its own DB row, created "via the
 * API after merge" rather than hand-inserted, and this is that endpoint).
 * Body: { name: string (required, trimmed, <=120 chars), ndc?: string |
 * null (validated/formatted by lib/ndc.ts's formatNdcForStorage — the
 * SAME helper PATCH /api/vaccines/[id] uses for its own `ndc` field, so a
 * new row's NDC is stored in the identical dashed 5-4-2 form), active?:
 * boolean (default true) }. Same auth guard as every other /api/vaccines*
 * route. Rejects a duplicate name (case-insensitive, trimmed) with 409 —
 * this table has no unique constraint on `name`, so the check is done
 * here rather than relying on the database to reject it. Returns
 * { vaccine } 201.
 */
export async function POST(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  try {
    const body = await request.json();
    const { name, ndc, active } = body ?? {};

    if (typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name is required." }, { status: 400 });
    }
    const trimmedName = name.trim();
    if (trimmedName.length > 120) {
      return NextResponse.json({ error: "name must be 120 characters or fewer." }, { status: 400 });
    }

    let formattedNdc: string | null = null;
    if (ndc !== undefined && ndc !== null) {
      if (typeof ndc !== "string") {
        return NextResponse.json({ error: "ndc must be a string or null." }, { status: 400 });
      }
      formattedNdc = formatNdcForStorage(ndc);
      if (!formattedNdc) {
        return NextResponse.json({ error: "ndc must be 10-11 digits (dashes optional)." }, { status: 400 });
      }
    }

    if (active !== undefined && typeof active !== "boolean") {
      return NextResponse.json({ error: "active must be a boolean." }, { status: 400 });
    }

    const supabase = getSupabaseServerClient();

    const { data: existing, error: existingError } = await supabase
      .from("vaccine")
      .select("id, name")
      .ilike("name", trimmedName);
    if (existingError) {
      console.error("POST /api/vaccines: Supabase error checking for duplicates", existingError);
      return NextResponse.json({ error: "Failed to create vaccine." }, { status: 500 });
    }
    if ((existing ?? []).some((row) => row.name.trim().toLowerCase() === trimmedName.toLowerCase())) {
      return NextResponse.json({ error: "A vaccine with this name already exists." }, { status: 409 });
    }

    const insertPayload: Record<string, unknown> = {
      name: trimmedName,
      ndc: formattedNdc,
      active: active ?? true,
    };

    const { data, error } = await supabase.from("vaccine").insert(insertPayload).select().single();
    if (error) {
      console.error("POST /api/vaccines: Supabase error", error);
      return NextResponse.json({ error: "Failed to create vaccine." }, { status: 500 });
    }

    return NextResponse.json({ vaccine: data }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
