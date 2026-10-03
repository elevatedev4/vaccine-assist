namespace VaccineAssist.Desktop.Services;

/// <summary>
/// The embedded cloud pages (WebView2) need an authenticated supabase-js
/// session, but the REAL refresh token must stay in exactly one place —
/// the desktop's SessionKeeper. Supabase refresh tokens rotate, so a
/// second holder (the page's own supabase-js auto-refresh timer) would
/// spend the token out from under the desktop and trip GoTrue's reuse
/// detection, revoking the whole session (the "signed out again" bug).
///
/// So the page is given only the short-lived access token plus this inert
/// placeholder in the refresh slot (supabase-js's setSession requires
/// one). The desktop pushes every refreshed access token into the page
/// (CloudPageView.PushDesktopAccessToken); if a push is ever missed the
/// page's refresh attempt fails harmlessly (unknown token — no
/// revocation) and it shows its own sign-in form. A side benefit: the
/// real refresh token is no longer written, in plaintext, into the
/// WebView2 profile's localStorage.
/// </summary>
public static class DesktopWebSession
{
    /// <summary>Not a credential. Must stay at least 10 characters
    /// (desktop-handoff/route.ts rejects shorter refresh tokens).</summary>
    public const string PlaceholderRefreshToken = "desktop-managed-session-no-refresh";

    /// <summary>The web-message type CloudPageView posts and
    /// cloud/app/desktop-handoff-bootstrap.tsx listens for.</summary>
    public const string PushMessageType = "va-desktop-session";
}
