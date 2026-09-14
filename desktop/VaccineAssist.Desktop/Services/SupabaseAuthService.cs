using System;
using System.Threading.Tasks;
using Supabase;
using VaccineAssist.Desktop.Settings;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// Wraps Supabase.Gotrue's email/password sign-in (via the Supabase
/// meta-package's Client.Auth) for the one shared pharmacy login. See
/// the csproj's PackageReference comment for why this app only uses the
/// SDK's Auth surface and nothing else.
/// </summary>
public sealed class SupabaseAuthService : IAuthService
{
    private readonly AppSettings _settings;
    private Client? _client;

    public SupabaseAuthService(AppSettings settings)
    {
        _settings = settings;
    }

    public bool IsSignedIn => AccessToken is not null;

    public string? AccessToken { get; private set; }

    public string? RefreshToken { get; private set; }

    public async Task<AuthResult> SignInAsync(string email, string password)
    {
        if (string.IsNullOrWhiteSpace(_settings.SupabaseUrl) || string.IsNullOrWhiteSpace(_settings.SupabaseAnonKey))
        {
            return AuthResult.Fail(
                "Supabase is not configured yet (SupabaseUrl/SupabaseAnonKey are blank in " +
                "%AppData%\\VaccineAssist\\settings.json). This is expected until a real Supabase " +
                "project exists — phase 1 has no live database calls.");
        }

        try
        {
            _client ??= new Client(_settings.SupabaseUrl, _settings.SupabaseAnonKey, new SupabaseOptions
            {
                AutoRefreshToken = true,
                AutoConnectRealtime = false,
            });
            await _client.InitializeAsync();

            var session = await _client.Auth.SignIn(email, password);
            if (string.IsNullOrEmpty(session?.AccessToken))
            {
                return AuthResult.Fail("Sign-in did not return a session. Check the shared login credentials.");
            }

            AccessToken = session.AccessToken;
            RefreshToken = session.RefreshToken;
            return AuthResult.Ok();
        }
        catch (Exception ex)
        {
            return AuthResult.Fail($"Sign-in failed: {ex.Message}");
        }
    }

    /// <summary>
    /// Will, 2026-09-13 (verbatim): "make that last for 90 days without
    /// requiring a login again, even if the program is restarted of
    /// course." LoginViewModel calls this once at startup with the
    /// access/refresh token pair it decrypted out of ISessionStore.
    /// forceAccessTokenRefresh: true is deliberate — the persisted access
    /// token is very likely expired by the time the app is restarted
    /// (access tokens are short-lived; only the refresh token is expected
    /// to still work), and SetSession still requires a syntactically
    /// valid JWT for that first parameter even when forcing a refresh, so
    /// the stale one we saved is passed through rather than an empty
    /// string.
    /// </summary>
    public async Task<AuthResult> TryRestoreSessionAsync(string accessToken, string refreshToken)
    {
        if (string.IsNullOrWhiteSpace(_settings.SupabaseUrl) || string.IsNullOrWhiteSpace(_settings.SupabaseAnonKey))
        {
            return AuthResult.Fail("Supabase is not configured yet.");
        }

        if (string.IsNullOrWhiteSpace(accessToken) || string.IsNullOrWhiteSpace(refreshToken))
        {
            return AuthResult.Fail("No persisted session to restore.");
        }

        try
        {
            _client ??= new Client(_settings.SupabaseUrl, _settings.SupabaseAnonKey, new SupabaseOptions
            {
                AutoRefreshToken = true,
                AutoConnectRealtime = false,
            });
            await _client.InitializeAsync();

            var session = await _client.Auth.SetSession(accessToken, refreshToken, forceAccessTokenRefresh: true);
            if (string.IsNullOrEmpty(session?.AccessToken))
            {
                return AuthResult.Fail("Could not restore the persisted session.");
            }

            AccessToken = session.AccessToken;
            // Gotrue rotates the refresh token on every use — fall back to
            // the one we were given only if the response somehow omitted
            // a new one, so the caller always has something to re-persist.
            RefreshToken = string.IsNullOrEmpty(session.RefreshToken) ? refreshToken : session.RefreshToken;
            return AuthResult.Ok();
        }
        catch (Exception ex)
        {
            return AuthResult.Fail($"Session restore failed: {ex.Message}");
        }
    }

    public async Task SignOutAsync()
    {
        AccessToken = null;
        RefreshToken = null;
        if (_client is not null)
        {
            await _client.Auth.SignOut();
        }
    }
}
