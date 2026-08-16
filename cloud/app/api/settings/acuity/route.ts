import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getAcuityCredentialsStatus } from "@/lib/acuity-credentials";

/**
 * Settings endpoint backing the /settings UI (see app/settings/page.tsx).
 * GET returns configuration status only — never the API key itself.
 * POST saves/replaces the stored Acuity credentials (user-friendly
 * alternative to handing us the key or setting env vars, per V-Q4).
 *
 * Leaving `acuityApiKey` blank on POST keeps the previously stored key
 * (the field is never prefilled in the UI, so "blank" is the only way a
 * user can update just the User ID without retyping the key).
 */
export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  const status = await getAcuityCredentialsStatus();
  return NextResponse.json(status);
}

export async function POST(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { acuityUserId, acuityApiKey } = (body ?? {}) as {
    acuityUserId?: unknown;
    acuityApiKey?: unknown;
  };

  const userId = typeof acuityUserId === "string" ? acuityUserId.trim() : "";
  const newApiKey = typeof acuityApiKey === "string" ? acuityApiKey.trim() : "";

  if (!userId) {
    return NextResponse.json({ error: "Acuity User ID is required." }, { status: 400 });
  }

  try {
    const supabase = getSupabaseServerClient();

    let keyToStore = newApiKey;
    if (!keyToStore) {
      const { data: existing } = await supabase
        .from("acuity_credentials")
        .select("acuity_api_key")
        .eq("id", 1)
        .maybeSingle();
      keyToStore = existing?.acuity_api_key ?? "";
    }

    if (!keyToStore) {
      return NextResponse.json(
        { error: "Acuity API key is required for initial setup." },
        { status: 400 }
      );
    }

    const { error } = await supabase.from("acuity_credentials").upsert({
      id: 1,
      acuity_user_id: userId,
      acuity_api_key: keyToStore,
      updated_by: auth.user.email ?? null,
    });

    if (error) {
      // Do not log `error.details`/etc. verbatim if it ever echoed the
      // key back (Supabase errors don't, but keep the logged surface
      // minimal on principle).
      console.error("POST /api/settings/acuity: Supabase error", error.message);
      return NextResponse.json({ error: "Failed to save Acuity credentials." }, { status: 500 });
    }

    const status = await getAcuityCredentialsStatus();
    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
