import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { DESKTOP_HANDOFF_COOKIE_NAME } from "@/lib/desktop-handoff";

/**
 * Desktop -> embedded-WebView2 session handoff (Will's brief: "Require
 * sign in when the app loads before anything is shown" — a corollary of
 * that is the embedded cloud pages must NOT show their OWN separate
 * sign-in form once the desktop app has already signed in). The desktop's
 * MainWindow.NavigateToDesktopHandoffAsync POSTs the current Supabase
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
 * Never logs the tokens themselves.
 */

type DesktopHandoffBody = {
  access_token?: unknown;
  refresh_token?: unknown;
};

function isPlausibleToken(value: unknown, minLength: number): value is string {
  return typeof value === "string" && value.trim().length >= minLength;
}

export async function POST(request: Request) {
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
  // obviously-missing/placeholder values — the real validity check is the
  // getUser() call below.
  if (!isPlausibleToken(access_token, 20)) {
    return NextResponse.json({ error: "Missing or malformed access_token." }, { status: 400 });
  }
  if (!isPlausibleToken(refresh_token, 10)) {
    return NextResponse.json({ error: "Missing or malformed refresh_token." }, { status: 400 });
  }

  try {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser(access_token);
    if (error || !data.user) {
      return NextResponse.json({ error: "Invalid or expired session." }, { status: 401 });
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
    // localStorage once the bootstrap runs setSession).
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 60,
  });
  return response;
}
