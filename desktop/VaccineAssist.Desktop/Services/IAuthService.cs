using System;
using System.Threading;
using System.Threading.Tasks;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// The shared pharmacy login (one Supabase Auth email/password account
/// used by everyone at the pharmacy — no per-staff accounts in phase 1).
/// </summary>
public interface IAuthService
{
    bool IsSignedIn { get; }

    /// <summary>Current Supabase access token, or null when not signed in.
    /// A snapshot — it can be up to ~1 h old. Anything that sends it
    /// somewhere should use GetValidAccessTokenAsync instead.</summary>
    string? AccessToken { get; }

    /// <summary>Current Supabase refresh token, or null when not signed in.
    /// Owned by the session keeper (which persists it, DPAPI-protected,
    /// after every rotation) — nothing else may refresh with it, and it is
    /// never handed to the embedded web page.</summary>
    string? RefreshToken { get; }

    /// <summary>Raised after a background/on-demand refresh produced a new
    /// access token (already persisted). Runs on a thread-pool thread.</summary>
    event EventHandler<string>? AccessTokenRefreshed;

    /// <summary>Raised when a RUNNING session ends for good (Supabase
    /// rejected the refresh token, or the 90-day ceiling passed).
    /// session.json is already cleared; the app shows the sign-in window.
    /// Thread-pool thread. Not raised for sign-out or startup restore.</summary>
    event EventHandler<string>? SessionEnded;

    Task<AuthResult> SignInAsync(string email, string password);

    /// <summary>One-shot recovery for an API 401: refreshes once (serialized,
    /// rate-limited, no-op if the rejected token was already replaced) and
    /// returns the token to retry with, or null when there is no session.</summary>
    Task<string?> RefreshAfterUnauthorizedAsync(string rejectedAccessToken, CancellationToken cancellationToken = default);

    /// <summary>
    /// The access token to send on a request: refreshed first (serialized,
    /// persisted) if it is expired or about to be. Null when not signed
    /// in. A transient refresh failure returns the current token.
    /// </summary>
    Task<string?> GetValidAccessTokenAsync(CancellationToken cancellationToken = default);

    /// <summary>
    /// Restores the persisted session (LoginViewModel's 90-day silent
    /// sign-in) — refreshing an expired access token, retrying with
    /// backoff when the service can't be reached. A failure with
    /// AuthResult.IsTransient set means the saved sign-in is intact and
    /// must NOT be treated as invalid; any other failure means the
    /// session is definitively over (and session.json has been cleared).
    /// <paramref name="issuedAtUtc"/> is the last INTERACTIVE sign-in —
    /// the 90-day ceiling is measured from it.
    /// </summary>
    Task<AuthResult> TryRestoreSessionAsync(string accessToken, string refreshToken, DateTime issuedAtUtc);

    Task SignOutAsync();
}
