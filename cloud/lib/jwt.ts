/**
 * Minimal, unverified JWT payload decoding — used ONLY to read the
 * `session_id` claim off a Supabase access token that has ALREADY been
 * verified via `supabase.auth.getUser(token)` in requireAuthenticatedUser
 * (lib/auth.ts). Never use this to authenticate a request by itself; it
 * does not check the signature.
 *
 * Kept dependency-free (no jwt-decode package) since this is one base64
 * segment of a token whose signature was already checked elsewhere —
 * matches this repo's "pure helper, no new dependency for one small
 * thing" posture (see lib/auth-token.ts's split-out-for-testability
 * comment).
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The GoTrue `session_id` claim identifying which auth.sessions row this access token belongs to. */
export function getSessionIdFromToken(token: string): string | null {
  const payload = decodeJwtPayload(token);
  const sessionId = payload?.session_id;
  return typeof sessionId === "string" ? sessionId : null;
}
