import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser, extractBearerToken } from "@/lib/auth";

/**
 * POST /api/sessions/sign-out-everywhere — the Settings → Sessions page's
 * red "Sign out everywhere" button (V-sessions, Will 2026-09-13,
 * verbatim ask). Uses GoTrue's admin sign-out with `scope: "global"`
 * (supabase.auth.admin.signOut), which invalidates every refresh token
 * for the user tied to the caller's own access token — this doesn't
 * depend on supabase/migrations/0013_session_management.sql at all
 * (no RPC involved), so it works even before that migration is applied,
 * unlike the per-row list/revoke routes.
 *
 * The caller's OWN token is immediately invalid afterward too (global
 * scope covers every session, including the one making this request) —
 * the page redirects to sign-in once this returns ok, and the Windows
 * desktop app's next refresh attempt gets a 401/refresh failure (see
 * this feature's report for what the desktop app needs to do about
 * that).
 */
export async function POST(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) {
    return NextResponse.json({ error: "Missing bearer token." }, { status: 401 });
  }

  try {
    const supabase = getSupabaseServerClient();
    const { error } = await supabase.auth.admin.signOut(token, "global");

    if (error) {
      console.error("POST /api/sessions/sign-out-everywhere: Supabase error", error);
      return NextResponse.json({ error: "Failed to sign out everywhere." }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
