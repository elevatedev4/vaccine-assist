import "server-only";
import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { extractBearerToken } from "@/lib/auth-token";

export { extractBearerToken };

/**
 * Verifies the request carries a valid Supabase session for the one
 * shared pharmacy login. The desktop app authenticates directly against
 * Supabase Auth (Supabase.Gotrue's Client.Auth.SignIn) and sends the
 * resulting access token as a Bearer header on every call into this
 * app's REST API — this is where that token gets checked before any
 * vaccine/lot/eligibility data is served.
 *
 * Returns the authenticated user on success, or a ready-to-return 401
 * NextResponse on failure — callers do:
 *
 *   const auth = await requireAuthenticatedUser(request);
 *   if ("error" in auth) return auth.error;
 *   // auth.user is available here
 */
export async function requireAuthenticatedUser(
  request: Request
): Promise<{ user: { id: string; email?: string } } | { error: NextResponse }> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) {
    return { error: NextResponse.json({ error: "Missing bearer token." }, { status: 401 }) };
  }

  try {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      return { error: NextResponse.json({ error: "Invalid or expired session." }, { status: 401 }) };
    }
    return { user: { id: data.user.id, email: data.user.email } };
  } catch (err) {
    return {
      error: NextResponse.json(
        { error: err instanceof Error ? err.message : "Supabase is not configured." },
        { status: 503 }
      ),
    };
  }
}
