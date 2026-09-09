import { NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { isMissingTableError } from "@/lib/schema-degradation";
import { WALK_IN_PCT_SETTING_KEY, getWalkInPct, isValidWalkInPct } from "@/lib/ordering-settings";

/**
 * GET/PUT /api/ordering/settings — the Ordering page's "Walk-up %"
 * setting (V-T26 item 1, Will 2026-09-09; see
 * lib/ordering-recommendation.ts's WALK_IN_BUFFER_RATE doc comment).
 * Shared account-wide, same "auth like the targets route" posture as
 * app/api/ordering/targets/route.ts. Backed by the generic
 * `app_setting` table (supabase/migrations/0012_app_setting.sql), which
 * is MIGRATION FILE ONLY per Will's brief — both routes degrade to a
 * pending response rather than erroring when that table doesn't exist
 * yet (same posture as GET/PUT /api/ordering/targets before 0011).
 *
 * Currently the only key this route reads/writes is
 * "ordering.walk_in_pct" — a generic `key`/`value` table was chosen
 * (rather than a one-off `walk_in_pct` column somewhere) so a future
 * account-wide setting doesn't need its own migration.
 *
 * RESPONSE CONTRACTS:
 *   GET -> { walkInPct: number, pending: boolean }
 *          (pending:true means app_setting doesn't exist yet — the
 *          value is the DEFAULT_WALK_IN_PCT fallback, not a saved one)
 *   PUT body { walkInPct: number }  (integer 0-100)
 *       -> { walkInPct: number } on success
 *       or, before 0012 has run: { pending: true } (200, not an error —
 *          same "don't crash, just don't persist yet" posture as
 *          PUT /api/ordering/targets)
 */

export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }

  try {
    const { pct, pending } = await getWalkInPct(supabase);
    return NextResponse.json({ walkInPct: pct, pending });
  } catch (err) {
    console.error("GET /api/ordering/settings: failed to load ordering.walk_in_pct", err);
    return NextResponse.json({ error: "Failed to load ordering settings." }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400 });
  }
  const { walkInPct } = body as Record<string, unknown>;

  if (!isValidWalkInPct(walkInPct)) {
    return NextResponse.json({ error: "walkInPct must be an integer between 0 and 100." }, { status: 400 });
  }

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }

  const { error } = await supabase
    .from("app_setting")
    .upsert(
      { key: WALK_IN_PCT_SETTING_KEY, value: walkInPct, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );

  if (error) {
    if (isMissingTableError(error)) {
      return NextResponse.json({ pending: true });
    }
    console.error("PUT /api/ordering/settings: failed to save ordering.walk_in_pct", error);
    return NextResponse.json({ error: "Failed to save the setting." }, { status: 500 });
  }

  return NextResponse.json({ walkInPct });
}
