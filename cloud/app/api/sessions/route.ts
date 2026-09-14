import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser, extractBearerToken } from "@/lib/auth";
import { getSessionIdFromToken } from "@/lib/jwt";
import { labelDeviceFromUserAgent } from "@/lib/session-device-label";
import { isMissingFunctionError } from "@/lib/schema-degradation";

/**
 * GET /api/sessions — lists the calling user's Supabase auth sessions
 * for the Settings → Sessions page (V-sessions, Will 2026-09-13): "include
 * a page in the cloud to manage these sessions."
 *
 * Reads via the `public.list_my_sessions` SECURITY DEFINER function
 * (supabase/migrations/0013_session_management.sql) rather than
 * `auth.sessions` directly — see that migration's header comment for
 * why. Degrades to `{ pending: true }` (same shape as
 * GET /api/on-hand/address) if the migration hasn't been applied yet.
 *
 * `isCurrent` is matched against the `session_id` claim on the caller's
 * own access token (decoded, not re-verified — the token was already
 * verified by requireAuthenticatedUser's supabase.auth.getUser call).
 */
export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  const token = extractBearerToken(request.headers.get("authorization"));
  const currentSessionId = token ? getSessionIdFromToken(token) : null;

  try {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase.rpc("list_my_sessions", { uid: auth.user.id });

    if (error) {
      if (isMissingFunctionError(error)) {
        return NextResponse.json({ pending: true });
      }
      console.error("GET /api/sessions: Supabase error", error);
      return NextResponse.json({ error: "Failed to load sessions." }, { status: 500 });
    }

    const rows = (data ?? []) as Array<{
      id: string;
      created_at: string;
      updated_at: string;
      refreshed_at: string | null;
      user_agent: string | null;
    }>;

    const sessions = rows.map((row) => ({
      id: row.id,
      device: labelDeviceFromUserAgent(row.user_agent),
      createdAt: row.created_at,
      lastActiveAt: row.refreshed_at ?? row.updated_at,
      isCurrent: currentSessionId !== null && row.id === currentSessionId,
    }));

    return NextResponse.json({ sessions });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
