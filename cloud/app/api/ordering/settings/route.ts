import { NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { isMissingTableError } from "@/lib/schema-degradation";
import {
  DEFAULT_MFLUSIVA_PCT,
  MFLUSIVA_PCT_SETTING_KEY,
  WALK_IN_PCT_SETTING_KEY,
  getMflusivaPct,
  getWalkInPct,
  isValidMflusivaPct,
  isValidWalkInPct,
} from "@/lib/ordering-settings";

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
 * Keys this route reads/writes: "ordering.walk_in_pct" and (V-Q16)
 * "ordering.mflusiva_pct" (the share of 50-64 flu counted as mFLUSIVA,
 * default 40) — a generic `key`/`value` table was chosen
 * (rather than a one-off `walk_in_pct` column somewhere) so a future
 * account-wide setting doesn't need its own migration.
 *
 * RESPONSE CONTRACTS:
 *   GET -> { walkInPct: number, mflusivaPct: number, pending: boolean }
 *          (pending:true means app_setting doesn't exist yet — the
 *          value is the DEFAULT_WALK_IN_PCT fallback, not a saved one)
 *   PUT body { walkInPct?: number, mflusivaPct?: number }  (each an
 *       integer 0-100; at least one required)
 *       -> the saved field(s), e.g. { walkInPct } or { mflusivaPct }, on success
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
    // A failed mFLUSIVA read must not hide the walk-up %: fall back to 40.
    let mflusivaPct = DEFAULT_MFLUSIVA_PCT;
    try {
      mflusivaPct = (await getMflusivaPct(supabase)).pct;
    } catch (err) {
      console.error("GET /api/ordering/settings: failed to load ordering.mflusiva_pct", err);
    }
    return NextResponse.json({ walkInPct: pct, mflusivaPct, pending });
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
  const { walkInPct, mflusivaPct } = body as Record<string, unknown>;

  if (walkInPct === undefined && mflusivaPct === undefined) {
    return NextResponse.json({ error: "walkInPct must be an integer between 0 and 100." }, { status: 400 });
  }
  if (walkInPct !== undefined && !isValidWalkInPct(walkInPct)) {
    return NextResponse.json({ error: "walkInPct must be an integer between 0 and 100." }, { status: 400 });
  }
  if (mflusivaPct !== undefined && !isValidMflusivaPct(mflusivaPct)) {
    return NextResponse.json({ error: "mflusivaPct must be an integer between 0 and 100." }, { status: 400 });
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

  const now = new Date().toISOString();
  const rows: Array<{ key: string; value: number; updated_at: string }> = [];
  if (walkInPct !== undefined) rows.push({ key: WALK_IN_PCT_SETTING_KEY, value: walkInPct as number, updated_at: now });
  if (mflusivaPct !== undefined) rows.push({ key: MFLUSIVA_PCT_SETTING_KEY, value: mflusivaPct as number, updated_at: now });

  // One upsert call per key (single-row shape, same as before this change).
  let error: unknown = null;
  for (const row of rows) {
    const result = await supabase.from("app_setting").upsert(row, { onConflict: "key" });
    if (result.error) {
      error = result.error;
      break;
    }
  }

  if (error) {
    if (isMissingTableError(error)) {
      return NextResponse.json({ pending: true });
    }
    console.error("PUT /api/ordering/settings: failed to save an ordering setting", error);
    return NextResponse.json({ error: "Failed to save the setting." }, { status: 500 });
  }

  return NextResponse.json({
    ...(walkInPct !== undefined ? { walkInPct } : {}),
    ...(mflusivaPct !== undefined ? { mflusivaPct } : {}),
  });
}
