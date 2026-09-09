import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { isMissingTableError } from "@/lib/schema-degradation";
import {
  BUD_ENABLED_PRODUCTS_SETTING_KEY,
  getBudEnabledProductKeys,
  isValidProductKeyList,
} from "@/lib/lots-settings";

/**
 * GET/PUT /api/lots/settings — which product(s) show an editable
 * beyond-use-date cell on /lots (V-T-ordering-lots-round3, Will
 * 2026-09-09 verbatim: "Beyond-use date only needs to apply to mNexspike
 * right now. Add a settings menu icon to the end of each row where you
 * can enable Beyond Use Date too."). Auth like every other
 * desktop/cloud-facing route (requireAuthenticatedUser). Backed by the
 * generic `app_setting` table (see lib/lots-settings.ts's doc comment).
 *
 * GET also loads the live `vaccine` catalog (needed to compute the
 * DEFAULT productKey list when nothing's been saved yet — see
 * lib/lots-settings.ts's defaultBudEnabledProductKeys) — `vaccine` is a
 * core table from 0001_init.sql, so this never degrades the way
 * `app_setting` itself does below.
 *
 * RESPONSE CONTRACTS:
 *   GET -> { budEnabledProductKeys: string[], pending: boolean }
 *   PUT body { budEnabledProductKeys: string[] }
 *       -> { budEnabledProductKeys: string[] } on success
 *       or, before 0012 has run: { pending: true } (200, not an error —
 *          same "don't crash, just don't persist yet" posture as
 *          PUT /api/ordering/settings)
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

  const { data: vaccinesData, error: vaccinesError } = await supabase
    .from("vaccine")
    .select("id, name, ndc, active")
    .order("name", { ascending: true });
  if (vaccinesError) {
    console.error("GET /api/lots/settings: failed to load vaccine catalog", vaccinesError);
    return NextResponse.json({ error: "Failed to load vaccine catalog." }, { status: 500 });
  }

  try {
    const { productKeys, pending } = await getBudEnabledProductKeys(supabase, vaccinesData ?? []);
    return NextResponse.json({ budEnabledProductKeys: productKeys, pending });
  } catch (err) {
    console.error("GET /api/lots/settings: failed to load lots.bud_enabled_products", err);
    return NextResponse.json({ error: "Failed to load lots settings." }, { status: 500 });
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
  const { budEnabledProductKeys } = body as Record<string, unknown>;
  if (!isValidProductKeyList(budEnabledProductKeys)) {
    return NextResponse.json({ error: "budEnabledProductKeys must be an array of strings." }, { status: 400 });
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
      { key: BUD_ENABLED_PRODUCTS_SETTING_KEY, value: budEnabledProductKeys, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );

  if (error) {
    if (isMissingTableError(error)) {
      return NextResponse.json({ pending: true });
    }
    console.error("PUT /api/lots/settings: failed to save lots.bud_enabled_products", error);
    return NextResponse.json({ error: "Failed to save the setting." }, { status: 500 });
  }

  return NextResponse.json({ budEnabledProductKeys });
}
