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
