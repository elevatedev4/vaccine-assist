using System.Threading.Tasks;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// The shared pharmacy login (one Supabase Auth email/password account
/// used by everyone at the pharmacy — no per-staff accounts in phase 1).
/// </summary>
public interface IAuthService
{
    bool IsSignedIn { get; }

    /// <summary>Current Supabase access token, or null when not signed in. Sent
    /// as an Authorization: Bearer header by VaccineApiService.</summary>
    string? AccessToken { get; }

    /// <summary>Current Supabase refresh token, or null when not signed in —
    /// the thing LoginViewModel persists (DPAPI-protected, via
    /// ISessionStore) for the 90-day silent sign-in. Never sent as a
    /// bearer header; only ever handed back to SetSession/TryRestoreSessionAsync.</summary>
    string? RefreshToken { get; }

    Task<AuthResult> SignInAsync(string email, string password);

    /// <summary>
    /// Restores a previously-persisted session (LoginViewModel's 90-day
    /// silent sign-in) from a stored access/refresh token pair, forcing a
    /// fresh access token from the refresh token regardless of whether
    /// the stored access token still looks unexpired — see
    /// SupabaseAuthService's implementation doc comment. On success,
    /// AccessToken/RefreshToken are updated exactly like a normal
    /// SignInAsync (Gotrue rotates the refresh token on every use, so the
    /// caller must re-persist it).
    /// </summary>
    Task<AuthResult> TryRestoreSessionAsync(string accessToken, string refreshToken);

    Task SignOutAsync();
}
