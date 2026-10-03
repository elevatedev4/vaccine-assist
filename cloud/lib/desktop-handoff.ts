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
 * Web-message type the desktop app (CloudPageView.PushDesktopAccessToken ->
 * CoreWebView2.PostWebMessageAsJson) posts into the embedded page every
 * time it refreshes the Supabase session. Must match
 * DesktopWebSession.PushMessageType in desktop/.../Services.
 */
export const DESKTOP_SESSION_MESSAGE_TYPE = "va-desktop-session";

/**
 * WHY THE DESKTOP PUSHES TOKENS (2026-10-03, "people have to sign in 1-2
 * times a day per workstation"): Supabase refresh tokens rotate — using
 * one invalidates it, and presenting an already-used one revokes the whole
 * session. The desktop used to hand its REAL refresh token to this page,
 * whose supabase-js auto-refresh timer then rotated it independently of
 * the desktop's copy, so one of the two always ended up holding a spent
 * token. Now the desktop keeps the only real refresh token, hands this
 * page the access token plus an inert placeholder, and posts a fresh
 * access token here whenever it refreshes. This parses that message;
 * anything that isn't exactly the expected shape is ignored.
 */
export function parseDesktopSessionMessage(
  data: unknown
): { access_token: string; refresh_token: string } | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message.type !== DESKTOP_SESSION_MESSAGE_TYPE) return null;
  const { access_token, refresh_token } = message;
  if (typeof access_token !== "string" || access_token.length < 20) return null;
  if (typeof refresh_token !== "string" || refresh_token.length < 10) return null;
  return { access_token, refresh_token };
}

/**
 * True when this page is hosted inside the desktop app's WebView2 (the
 * host injects `window.chrome.webview`). There the page holds only a
 * short-lived access token plus a placeholder refresh token (see
 * parseDesktopSessionMessage), so its supabase-js client must NOT run its
 * own refresh timer: the attempt can only fail, and a failed refresh makes
 * supabase-js delete the session from localStorage — which every WebView2
 * window on the shared profile (the main page AND the Ctrl+8 macro-codes
 * popup) reads. The desktop keeps the stored token fresh instead.
 */
export function isDesktopWebViewHost(win: unknown): boolean {
  if (!win || typeof win !== "object") return false;
  const chrome = (win as { chrome?: { webview?: unknown } }).chrome;
  return !!chrome && typeof chrome === "object" && !!chrome.webview;
}
