import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { DESKTOP_HANDOFF_COOKIE_NAME, isTrustedDesktopRequest } from "@/lib/desktop-handoff";

/**
 * Desktop -> embedded-WebView2 session handoff (Will's brief: "Require
 * sign in when the app loads before anything is shown" — a corollary of
 * that is the embedded cloud pages must NOT show their OWN separate
 * sign-in form once the desktop app has already signed in). The desktop's
 * CloudPageView.PerformDesktopHandoffAsync POSTs the current Supabase
 * session's { access_token, refresh_token } here, before MainWindow is
 * ever shown, using the ONE main WebView2 surface — see that method's doc
 * comment.
 *
 * IMPORTANT ARCHITECTURE NOTE: this app's cloud pages authenticate purely
 * CLIENT-SIDE via supabase-js's browser client (persistSession: true ->
 * the SDK's own localStorage entry — see lib/supabase/client.ts and
 * lib/supabase/session.ts's subscribeToSessionState, which every page
 * calls). There is no @supabase/ssr / cookie-based session anywhere in
 * this codebase (confirmed: no other route reads or writes a session
 * cookie) for this route to slot into — so instead of writing the "same
 * cookies the browser login flow writes" (there are none), this route
 * validates the tokens server-side and hands them to the browser via a
 * short-lived, one-shot cookie that DesktopHandoffBootstrap (see
 * app/desktop-handoff-bootstrap.tsx, mounted from the root layout) reads
 * on the very next page load and feeds into the SAME
 * getSupabaseBrowserClient().auth.setSession(...) call an interactive
 * sign-in would use — which is what actually persists the session into
 * this WebView2 profile's localStorage. The cookie is transport for one
 * redirect hop only, never the session store itself, and is cleared by
 * the bootstrap the moment it's read (success or failure).
 *
 * SECURITY REVIEW FIX (login CSRF, blocker): this endpoint used to accept
 * a POST from anywhere — a cross-site page could POST JSON at it via the
 * classic text/plain-form trick and sign a victim's browser into the
 * ATTACKER's account (the attacker supplies their own valid
 * access_token/refresh_token; nothing here checked where the request came
 * from). isTrustedDesktopRequest (lib/desktop-handoff.ts — moved out of
 * this file since a route file may only export HTTP handlers/config) now
 * requires ALL of: the desktop-only
 * X-Vaccine-Assist-Desktop header (set only by
 * CloudPageView.PerformDesktopHandoffAsync — see that method), a JSON
 * content type, and — when the browser sends them at all — Origin/
 * Sec-Fetch-Site values consistent with a same-origin request. A page on
 * an attacker's origin cannot set custom headers on a simple/no-CORS POST
 * and cannot spoof Sec-Fetch-Site, so this closes the hole even though
 * the cookie this route sets is deliberately NOT httpOnly (see below).
 *
 * Never logs the tokens themselves.
 *
 * NO "revoke the user's other desktop sessions" cleanup any more
 * (removed 2026-10-03): it revoked every other session of the shared
 * pharmacy login that had a non-browser user agent and the same public
 * IP — i.e. every OTHER WORKSTATION in the pharmacy. Each launch on one
 * PC signed the rest out (the "sign in 1-2 times a day per workstation"
 * bug). It existed to stop duplicate rows in Settings -> Sessions when
 * every launch created a new session; launches now restore the stored
 * session instead, so there is nothing left to tidy.
 */

type DesktopHandoffBody = {
  access_token?: unknown;
  refresh_token?: unknown;
};

function isPlausibleToken(value: unknown, minLength: number): value is string {
  return typeof value === "string" && value.trim().length >= minLength;
}

export async function POST(request: Request) {
  if (!isTrustedDesktopRequest(request)) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  let body: DesktopHandoffBody;
  try {
    body = (await request.json()) as DesktopHandoffBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { access_token, refresh_token } = body ?? {};

  // Real Supabase access tokens are JWTs (three dot-separated base64url
  // segments, comfortably >20 chars); refresh tokens are shorter opaque
  // strings but never trivially short. These floors only reject
  // obviously-missing/placeholder values — the real validity checks are
  // the getUser()/setSession() calls below.
  if (!isPlausibleToken(access_token, 20)) {
    return NextResponse.json({ error: "Missing or malformed access_token." }, { status: 400 });
  }
  if (!isPlausibleToken(refresh_token, 10)) {
    return NextResponse.json({ error: "Missing or malformed refresh_token." }, { status: 400 });
  }

  try {
    const supabase = getSupabaseServerClient();
    const { data: userData, error: userError } = await supabase.auth.getUser(access_token);
    if (userError || !userData.user) {
      return NextResponse.json({ error: "Invalid or expired session." }, { status: 401 });
    }

    // SECURITY REVIEW FIX (blocker): refresh_token used to be
    // length-checked only, never actually verified. setSession() re-checks
    // the access token (redundant with the getUser() call above, cheap)
    // and, ONLY when the access token has already expired, redeems
    // refresh_token against Supabase's token endpoint — the one way GoTrue
    // exposes to verify a refresh token belongs to a real session at all,
    // since refresh tokens are opaque (nothing to decode/verify locally).
    // Comparing the resulting session's user id against the access
    // token's own user id (from getUser() above) rejects a mismatched or
    // garbage refresh_token paired with someone else's access_token.
    //
    // ROTATION (read before changing this): Supabase refresh tokens are
    // single-use/rotating, and re-presenting a spent one revokes the whole
    // session. The desktop therefore NEVER sends its real refresh token
    // here (since 2026-10-03 it sends an inert placeholder — see
    // lib/desktop-handoff.ts parseDesktopSessionMessage), and always
    // sends an access token with plenty of life left, so setSession below
    // never reaches its redeem branch. If it ever did (an expired access
    // token + the placeholder), the redeem simply fails with 401 — it can
    // no longer rotate away the desktop's real token.
    const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
      access_token,
      refresh_token,
    });
    if (sessionError || !sessionData.session || sessionData.session.user.id !== userData.user.id) {
      return NextResponse.json({ error: "Invalid or mismatched session." }, { status: 401 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }

  const response = NextResponse.redirect(new URL("/", request.url), { status: 303 });
  // NextResponse's cookie serializer percent-encodes the value itself
  // (the JSON payload's quotes/braces/colons aren't valid raw cookie-octet
  // characters per RFC 6265) — DesktopHandoffBootstrap's document.cookie
  // read gets that same percent-encoded string back verbatim (browsers
  // don't auto-decode cookie values) and decodeURIComponent's it once.
  const cookieValue = JSON.stringify({ access_token, refresh_token });
  response.cookies.set(DESKTOP_HANDOFF_COOKIE_NAME, cookieValue, {
    // Must be readable by DesktopHandoffBootstrap's client-side script —
    // this cookie is a one-shot transport for the redirect below, not a
    // security boundary of its own (the real session lives in
    // localStorage once the bootstrap runs setSession). httpOnly stays
    // false for that reason; secure:true (SECURITY REVIEW FIX, blocker)
    // ensures it's never sent/set over a plain-HTTP connection regardless
    // — this app is only ever served over HTTPS (Vercel) and by the
    // desktop's WebView2 hitting that same HTTPS URL, so this has no
    // functional downside.
    httpOnly: false,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60,
  });
  return response;
}
