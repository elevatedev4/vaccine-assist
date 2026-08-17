import type { Session, SupabaseClient } from "@supabase/supabase-js";

/**
 * Minimal projection of a Supabase session that client UI needs: enough
 * to gate authenticated calls (accessToken) and show who's signed in
 * (email). Kept separate from the full Session type so components don't
 * reach into Supabase internals directly.
 */
export type SessionState = { accessToken: string; email: string | null } | null;

/** Pure projection from a Supabase session to the minimal state the UI needs. */
export function toSessionState(session: Session | null): SessionState {
  if (!session) return null;
  return {
    accessToken: session.access_token,
    email: session.user?.email ?? null,
  };
}

/**
 * Hydrates session state once on call (via getSession, which reads the
 * persisted session from storage) and keeps it in sync afterward via
 * onAuthStateChange (covers sign-in, sign-out, token refresh, and
 * expiry). Returns an unsubscribe function — call it on unmount.
 *
 * This is the fix for sessions only living in component state: a page
 * that called getSession() once on mount and never subscribed would
 * show a stale "signed in" state after the token was refreshed or
 * revoked elsewhere, and would show nothing during the async gap before
 * getSession() resolved.
 */
export function subscribeToSessionState(
  supabase: SupabaseClient,
  onChange: (state: SessionState) => void
): () => void {
  let cancelled = false;

  void supabase.auth.getSession().then(({ data }) => {
    if (!cancelled) onChange(toSessionState(data.session));
  });

  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event, session) => {
    if (!cancelled) onChange(toSessionState(session));
  });

  return () => {
    cancelled = true;
    subscription.unsubscribe();
  };
}
