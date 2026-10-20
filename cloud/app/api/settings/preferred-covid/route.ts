import { NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { isMissingTableError } from "@/lib/schema-degradation";
import { getPreferredCovid } from "@/lib/preferred-covid-settings";
import { PREFERRED_COVID_SETTING_KEY, isValidPreferredCovid } from "@/lib/preferred-covid";

/**
 * GET/PUT /api/settings/preferred-covid - the pharmacy-wide preferred COVID
 * vaccine for ages 12+ and for ages 3-11 (V-Q11, Will 2026-10-20). Edited on
 * the Data Entry tab; read by the macro-codes "C" hotkey. Backed by the
 * existing generic `app_setting` table (0012) - no new migration. Authed
 * like every other settings route (requireAuthenticatedUser).
 *
 * RESPONSE CONTRACTS:
 *   GET -> { adult: "pfizer" | "moderna", kids: "moderna", pending: boolean }
 *          (defaults pfizer / moderna when nothing is saved; pending:true
 *          means app_setting does not exist yet)
 *   PUT body { adult, kids } (both required, both valid)
 *       -> { adult, kids } on success
 *       or { pending: true } (200) before 0012 has been applied
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
    const { setting, pending } = await getPreferredCovid(supabase);
    return NextResponse.json({ ...setting, pending });
  } catch (err) {
    console.error("GET /api/settings/preferred-covid: failed to load the setting", err);
    return NextResponse.json({ error: "Failed to load the preferred COVID setting." }, { status: 500 });
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

  if (!isValidPreferredCovid(body)) {
    return NextResponse.json({ error: "adult and kids must each be a valid preferred COVID choice." }, { status: 400 });
  }
  const value = { adult: body.adult, kids: body.kids };

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
    .upsert({ key: PREFERRED_COVID_SETTING_KEY, value, updated_at: new Date().toISOString() }, { onConflict: "key" });

  if (error) {
    if (isMissingTableError(error)) return NextResponse.json({ pending: true });
    console.error("PUT /api/settings/preferred-covid: failed to save the setting", error);
    return NextResponse.json({ error: "Failed to save the setting." }, { status: 500 });
  }

  return NextResponse.json(value);
}
