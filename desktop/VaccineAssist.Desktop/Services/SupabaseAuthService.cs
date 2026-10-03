using System;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Supabase;
using VaccineAssist.Desktop.Logging;
using VaccineAssist.Desktop.Settings;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// Wraps Supabase Auth for the one shared pharmacy login. The Supabase
/// SDK (Client.Auth) is used ONLY for the password sign-in call (and with
/// its own AutoRefreshToken timer OFF); everything about keeping the
/// session alive — refresh, rotation, persistence, the 90-day ceiling,
/// sign-out — lives in SessionKeeper, so there is exactly one party
/// rotating the refresh token and every rotation is persisted. See
/// SessionKeeper's doc comment for the root cause this fixes.
/// </summary>
public sealed class SupabaseAuthService : IAuthService
{
    /// <summary>How often the background maintenance tick checks whether
    /// the access token needs refreshing (the keeper only calls the
    /// network when it is within RefreshSkew of expiring).</summary>
    private static readonly TimeSpan MaintenanceInterval = TimeSpan.FromMinutes(1);

    private readonly AppSettings _settings;
    private readonly SessionKeeper _keeper;
    private readonly object _timerLock = new();
    private Client? _client;
    private Timer? _maintenanceTimer;

    public SupabaseAuthService(AppSettings settings, ISessionStore sessionStore, HttpClient httpClient)
    {
        _settings = settings;
        _keeper = new SessionKeeper(
            sessionStore,
            new HttpSupabaseTokenEndpoint(httpClient, settings),
            log: message => AppFileLog.Log($"[Session] {message}"));
        _keeper.AccessTokenRefreshed += (_, token) => AccessTokenRefreshed?.Invoke(this, token);
        _keeper.SessionEnded += (_, reason) =>
        {
            StopMaintenance();
            SessionEnded?.Invoke(this, reason);
        };
    }

    public bool IsSignedIn => _keeper.HasSession;

    public string? AccessToken => _keeper.AccessToken;

    public string? RefreshToken => _keeper.RefreshToken;

    public event EventHandler<string>? AccessTokenRefreshed;

    public event EventHandler<string>? SessionEnded;

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
                // OFF on purpose: the SDK's refresh timer rotated the
                // refresh token in memory without persisting it.
                // SessionKeeper is the only refresher.
                AutoRefreshToken = false,
                AutoConnectRealtime = false,
            });
            await _client.InitializeAsync();

            var session = await _client.Auth.SignIn(email, password);
            if (string.IsNullOrEmpty(session?.AccessToken) || string.IsNullOrEmpty(session.RefreshToken))
            {
                return AuthResult.Fail("Sign-in did not return a session. Check the shared login credentials.");
            }

            _keeper.StartInteractiveSession(session.AccessToken, session.RefreshToken);
            StartMaintenance();
            return AuthResult.Ok();
        }
        catch (Exception ex)
        {
            return AuthResult.Fail($"Sign-in failed: {ex.Message}");
        }
    }

    public Task<string?> GetValidAccessTokenAsync(CancellationToken cancellationToken = default) =>
        _keeper.GetValidAccessTokenAsync(cancellationToken);

    public Task<string?> RefreshAfterUnauthorizedAsync(string rejectedAccessToken, CancellationToken cancellationToken = default) =>
        _keeper.RefreshAfterUnauthorizedAsync(rejectedAccessToken, cancellationToken);

    public async Task<AuthResult> TryRestoreSessionAsync(string accessToken, string refreshToken, DateTime issuedAtUtc)
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
            var result = await _keeper.RestoreAsync(new PersistedSession(accessToken, refreshToken, issuedAtUtc));
            if (result.Success)
            {
                StartMaintenance();
            }

            return result;
        }
        catch (Exception ex)
        {
            // Not a verdict on the credential — keep the stored session.
            return AuthResult.TransientFail($"Session restore failed: {ex.GetType().Name}");
        }
    }

    public async Task SignOutAsync()
    {
        StopMaintenance();
        await _keeper.SignOutAsync();
    }

    private void StartMaintenance()
    {
        lock (_timerLock)
        {
            _maintenanceTimer ??= new Timer(
                _ => { _ = MaintainAsync(); },
                state: null,
                dueTime: MaintenanceInterval,
                period: MaintenanceInterval);
        }
    }

    private void StopMaintenance()
    {
        lock (_timerLock)
        {
            _maintenanceTimer?.Dispose();
            _maintenanceTimer = null;
        }
    }

    private async Task MaintainAsync()
    {
        try
        {
            await _keeper.GetValidAccessTokenAsync();
        }
        catch (Exception ex)
        {
            AppFileLog.Log($"[Session] maintenance refresh failed ({ex.GetType().Name})");
        }
    }
}
