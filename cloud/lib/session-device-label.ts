/**
 * Friendly device labels for the Settings → Sessions page (V-sessions,
 * Will 2026-09-13: "include a page in the cloud to manage these
 * sessions... sign out everywhere button").
 *
 * The two clients that ever authenticate against Supabase here are the
 * Windows desktop app (desktop/VaccineAssist.Desktop, via the `Supabase`
 * NuGet package — gotrue-csharp underneath) and a browser hitting one of
 * the cloud pages (Settings itself uses the shared login — see
 * app/settings/page.tsx). The desktop HTTP client never sets an explicit
 * `User-Agent` header (checked: no reference anywhere under desktop/),
 * so GoTrue records either nothing or a generic non-browser default for
 * it — a `user_agent` value that doesn't look like a browser's is
 * treated as the desktop app. A real browser's UA always contains
 * "Mozilla/" (Chrome, Firefox, Safari, and Edge all still send that
 * token for compatibility), so that's the split point.
 *
 * Split out of labelDeviceFromUserAgent (V-sessions dedup, 2026-09-16) so
 * both the Settings -> Sessions grouping (lib/session-grouping.ts) and the
 * desktop-handoff duplicate-session cleanup
 * (app/api/auth/desktop-handoff/route.ts) can ask "does this session look
 * like the desktop app?" without string-matching the friendly label text
 * itself.
 */
export function isDesktopUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent || !userAgent.trim()) {
    return true;
  }
  return !userAgent.toLowerCase().includes("mozilla/");
}

export function labelDeviceFromUserAgent(userAgent: string | null | undefined): string {
  if (isDesktopUserAgent(userAgent)) {
    return "Windows desktop app";
  }

  const ua = userAgent!.toLowerCase();
  let browser = "Browser";
  if (ua.includes("edg/")) browser = "Edge";
  else if (ua.includes("chrome/") && !ua.includes("chromium/")) browser = "Chrome";
  else if (ua.includes("firefox/")) browser = "Firefox";
  else if (ua.includes("safari/") && !ua.includes("chrome/")) browser = "Safari";

  // iPhone/iPad UAs also contain "like Mac OS X" for compatibility, so
  // the iOS check must run before the Mac check.
  let os = "";
  if (ua.includes("windows")) os = "Windows";
  else if (ua.includes("iphone") || ua.includes("ipad")) os = "iOS";
  else if (ua.includes("mac os") || ua.includes("macintosh")) os = "Mac";
  else if (ua.includes("android")) os = "Android";
  else if (ua.includes("linux")) os = "Linux";

  return os ? `${browser} on ${os}` : browser;
}
