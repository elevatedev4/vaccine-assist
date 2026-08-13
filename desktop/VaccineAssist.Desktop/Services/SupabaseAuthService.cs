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
            return AuthResult.Ok();
        }
        catch (Exception ex)
        {
            return AuthResult.Fail($"Sign-in failed: {ex.Message}");
        }
    }

    public async Task SignOutAsync()
    {
        AccessToken = null;
        if (_client is not null)
        {
            await _client.Auth.SignOut();
        }
    }
}
