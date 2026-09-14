import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { isMissingFunctionError } from "@/lib/schema-degradation";

/**
 * DELETE /api/sessions/[id] — revokes one of the calling user's other
 * sessions (V-sessions, Will 2026-09-13: "revoke them as needed"). Goes
 * through `public.revoke_my_session` (supabase/migrations/0013_session_management.sql),
 * which scopes the delete to `user_id = uid` server-side — this route
 * never lets the caller revoke a session that isn't their own, since
 * `uid` here is the authenticated caller's own id, not client input.
 *
 * Returns 409 with `pending: true` if the migration hasn't been applied
 * yet (same posture as PATCH /api/lots/[id]'s beyondUseDateSupported
 * degrade for a write that has nowhere to land without it).
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing session id." }, { status: 400 });
  }

  try {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase.rpc("revoke_my_session", {
      uid: auth.user.id,
      target_id: id,
    });

    if (error) {
      if (isMissingFunctionError(error)) {
        return NextResponse.json(
          { error: "Session revocation isn't available yet — the migration hasn't run.", pending: true },
          { status: 409 }
        );
      }
      console.error("DELETE /api/sessions/[id]: Supabase error", error);
      return NextResponse.json({ error: "Failed to revoke session." }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
