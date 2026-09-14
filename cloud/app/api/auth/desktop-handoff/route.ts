import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { DESKTOP_HANDOFF_COOKIE_NAME } from "@/lib/desktop-handoff";

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
 * from). isTrustedDesktopRequest now requires ALL of: the desktop-only
 * X-Vaccine-Assist-Desktop header (set only by
 * CloudPageView.PerformDesktopHandoffAsync — see that method), a JSON
 * content type, and — when the browser sends them at all — Origin/
 * Sec-Fetch-Site values consistent with a same-origin request. A page on
 * an attacker's origin cannot set custom headers on a simple/no-CORS POST
 * and cannot spoof Sec-Fetch-Site, so this closes the hole even though
 * the cookie this route sets is deliberately NOT httpOnly (see below).
 *
 * Never logs the tokens themselves.
 */

type DesktopHandoffBody = {
  access_token?: unknown;
  refresh_token?: unknown;
};

function isPlausibleToken(value: unknown, minLength: number): value is string {
  return typeof value === "string" && value.trim().length >= minLength;
}

/**
 * See the class doc's CSRF fix note. Exported for direct unit testing.
 * Deliberately permissive about ABSENT headers (older WebView2/Chromium
 * builds, or a direct same-machine test call, may not send
 * Origin/Sec-Fetch-Site at all) — the ONE header this app controls and
 * always sends (X-Vaccine-Assist-Desktop) is the hard requirement; the
 * other two are checked only when present, exactly per the brief ("Origin
 * header is present and not the app's own origin" / "Sec-Fetch-Site must
 * be same-origin/none IF present").
 */
export function isTrustedDesktopRequest(request: Request): boolean {
  if (request.headers.get("x-vaccine-assist-desktop") !== "1") {
    return false;
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return false;
  }

  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return false;
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return false;
  }

  return true;
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
    // ROTATION CAVEAT (read before changing this): Supabase refresh
    // tokens are single-use/rotating — SupabaseAuthService.
    // TryRestoreSessionAsync's own doc comment already documents this
    // ("Gotrue rotates the refresh token on every use, so the caller must
    // re-persist it"). If this call DOES hit the redeem branch (an
    // already-expired access token reaching this endpoint — not the
    // normal path, since this always runs seconds after a fresh sign-in/
    // silent restore), the OLD refresh_token becomes invalid and the
    // NEWLY rotated one is known only to this server call, not propagated
    // back to the desktop's own SessionStore. Worst case that causes is
    // the desktop's 90-day silent restore failing on its NEXT launch
    // (recoverable with one manual sign-in) — not a security issue, and
    // not the common case, but a real, deliberately-accepted trade-off
    // documented here rather than silently ignored.
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
