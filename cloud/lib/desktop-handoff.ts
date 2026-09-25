import type { SupabaseClient } from "@supabase/supabase-js";
import { getSessionIdFromToken } from "@/lib/jwt";
import { isDesktopUserAgent } from "@/lib/session-device-label";
import { isMissingFunctionError } from "@/lib/schema-degradation";

/**
 * Shared constant between app/api/auth/desktop-handoff/route.ts (writes
 * this cookie after validating the desktop's tokens) and
 * app/desktop-handoff-bootstrap.tsx (reads + clears it on the client) —
 * see the route's doc comment for why a cookie is used here at all when
 * this app's real sessions live in localStorage.
 */
export const DESKTOP_HANDOFF_COOKIE_NAME = "va-desktop-handoff";

/**
 * See app/api/auth/desktop-handoff/route.ts's class doc comment for the
 * CSRF fix this guards against. Lives here (rather than in the route file)
 * because a Next.js App Router route file may only export HTTP method
 * handlers and route config — no other named exports are allowed in a
 * production build. Exported for direct unit testing.
 *
 * Deliberately permissive about ABSENT headers (older WebView2/Chromium
 * builds, or a direct same-machine test call, may not send
 * Origin/Sec-Fetch-Site at all) — the ONE header this app controls and
 * always sends (X-Vaccine-Assist-Desktop) is the hard requirement; the
 * other two are checked only when present, exactly per the brief ("Origin
 * header is present and not the app's own origin" / "Sec-Fetch-Site must
 * be same-origin/none IF present").
 *
 * BUG FIX (Will, 2026-09-25, verbatim: "shows an error every time I log
 * in ... {\"error\":\"Forbidden.\"}"): also permissive about an OPAQUE
 * initiator. CloudPageView.PerformDesktopHandoffAsync's
 * NavigateWithWebResourceRequest is the very FIRST navigation this
 * WebView2 instance ever makes — its initiating document is still
 * about:blank, which has an opaque origin. Per the Fetch/HTML "append a
 * request Origin header" step, browsers still add an Origin header to a
 * state-changing (POST) navigation from an opaque initiator, but
 * serialize it as the literal string "null" (not absent) — and the same
 * opaque-vs-real-origin comparison Sec-Fetch-Site is built from computes
 * "cross-site" for that same initiator, since an opaque origin never
 * matches any site. So EVERY desktop login hit this route with Origin:
 * "null" and (likely) Sec-Fetch-Site: cross-site, tripping both of the
 * below checks on a 100%-legitimate request.
 *
 * This exact shape can't be forged by a hostile web page carrying the
 * already-required X-Vaccine-Assist-Desktop header: an HTML form can't
 * set arbitrary request headers at all, and a fetch()/XHR that tried to
 * add one cross-origin would trigger a CORS preflight this route never
 * answers, so the browser blocks the real POST from ever being sent —
 * see the route's own CSRF doc comment. So Origin: "null" is trusted
 * here, and Sec-Fetch-Site: "cross-site" is trusted too but ONLY when
 * paired with that same opaque Origin (never on its own, which is still
 * the ordinary cross-site-attacker signature this guards against).
 */
export function isTrustedDesktopRequest(request: Request): boolean {
  if (request.headers.get("x-vaccine-assist-desktop") !== "1") {
    return false;
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return false;
  }

  const origin = request.headers.get("origin");
  const isOpaqueOrigin = origin === "null";

  const secFetchSite = request.headers.get("sec-fetch-site");
  if (
    secFetchSite &&
    secFetchSite !== "same-origin" &&
    secFetchSite !== "none" &&
    !(isOpaqueOrigin && secFetchSite === "cross-site")
  ) {
    return false;
  }

  if (origin && origin !== new URL(request.url).origin && !isOpaqueOrigin) {
    return false;
  }

  return true;
}

/**
 * Best-effort client IP from the usual proxy header (Vercel sets
 * x-forwarded-for). Returns null rather than guessing when absent —
 * callers must treat null as "can't identify the device," never as a
 * match against another null.
 */
export function getRequestIp(request: Request): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (!forwardedFor) return null;
  const first = forwardedFor.split(",")[0]?.trim();
  return first || null;
}

/**
 * Duplicate-session cleanup (Will, 2026-09-16, verbatim: "is there a way
 * to not show duplicate sessions if it's the same computer? I feel like
 * there were duplicates because there were so many listed"). Root cause:
 * the desktop app performs a brand-new Supabase sign-in (a new
 * auth.sessions row) on every launch that reaches
 * CloudPageView.PerformDesktopHandoffAsync, so the Settings -> Sessions
 * table grows one row per launch on the same workstation.
 *
 * Called right after app/api/auth/desktop-handoff/route.ts establishes
 * the NEW session: revokes this user's OTHER sessions that (a) look like
 * the desktop app (isDesktopUserAgent) and (b) share this request's IP —
 * the same (user_agent, ip) stand-in device marker
 * lib/session-grouping.ts uses to fold rows together in the UI, reused
 * here so the table actually stops growing instead of just looking
 * grouped. See that module's doc comment for why this heuristic was
 * chosen over adding a real per-machine device id: doing so needs either
 * a new auth.sessions column (a schema change, which the brief says to
 * STOP on if unavoidable) or a new desktop-sent header, and this
 * (user_agent, ip) pairing achieves the same practical result — one
 * accumulating row instead of many — for the common case (one desktop
 * app per workstation IP) without either.
 *
 * Never throws — the caller (the handoff route) must still complete a
 * successful sign-in even if this cleanup can't run at all (migration
 * 0013 not yet applied — isMissingFunctionError) or fails partway
 * through (logged, not surfaced). Skips entirely when requestIp is null:
 * without an IP there is nothing safe to match on, and matching two
 * null-ip rows against each other would revoke unrelated sessions.
 */
export async function revokeOlderDesktopSessionsForSameDevice(params: {
  supabase: SupabaseClient;
  userId: string;
  newSessionAccessToken: string;
  requestIp: string | null;
}): Promise<void> {
  const { supabase, userId, newSessionAccessToken, requestIp } = params;
  if (!requestIp) return;

  const newSessionId = getSessionIdFromToken(newSessionAccessToken);

  try {
    const { data, error } = await supabase.rpc("list_my_sessions", { uid: userId });
    if (error) {
      if (isMissingFunctionError(error)) return; // 0013 not applied yet — nothing to clean up
      console.error("revokeOlderDesktopSessionsForSameDevice: list_my_sessions failed", error);
      return;
    }

    const rows = (data ?? []) as Array<{ id: string; user_agent: string | null; ip: string | null }>;
    const staleIds = rows
      .filter((row) => row.id !== newSessionId)
      .filter((row) => isDesktopUserAgent(row.user_agent))
      .filter((row) => (row.ip ?? null) === requestIp)
      .map((row) => row.id);

    for (const staleId of staleIds) {
      const { error: revokeError } = await supabase.rpc("revoke_my_session", { uid: userId, target_id: staleId });
      if (revokeError) {
        console.error("revokeOlderDesktopSessionsForSameDevice: revoke_my_session failed", revokeError);
      }
    }
  } catch (err) {
    console.error("revokeOlderDesktopSessionsForSameDevice: unexpected error", err);
  }
}
