using System;

namespace VaccineAssist.Desktop.Settings;

/// <summary>
/// The in-memory (decrypted) form of the 90-day persisted sign-in Will
/// asked for (verbatim: "If a user logs in once on a computer, you
/// should make that last for 90 days without requiring a login again,
/// even if the program is restarted of course"). See SessionStore for
/// the on-disk, DPAPI-protected representation at
/// %LocalAppData%\VaccineAssist\session.json.
/// </summary>
public sealed class PersistedSession
{
    public PersistedSession(string accessToken, string refreshToken, DateTime issuedAtUtc)
    {
        AccessToken = accessToken;
        RefreshToken = refreshToken;
        IssuedAtUtc = issuedAtUtc;
    }

    /// <summary>
    /// Supabase access token at the time this was saved. May well be
    /// expired by the time it's read back (access tokens are short-lived
    /// by design) — SetSession is called with forceAccessTokenRefresh so
    /// that's expected and fine; a syntactically valid JWT is still
    /// required here since SetSession decodes it before refreshing.
    /// </summary>
    public string AccessToken { get; }

    /// <summary>Supabase refresh token — the thing that actually makes the
    /// 90-day restore work. Gotrue rotates this on every use, so
    /// LoginViewModel re-saves it (keeping IssuedAtUtc unchanged) after
    /// every successful silent restore.</summary>
    public string RefreshToken { get; }

    /// <summary>
    /// UTC timestamp of the last INTERACTIVE sign-in (manual or the
    /// seeded-autologin.json path) — NOT updated by a silent restore. The
    /// 90-day window (SessionExpiry.MaxAgeDays) is measured from this.
    /// </summary>
    public DateTime IssuedAtUtc { get; }
}
