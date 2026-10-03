using System;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Settings;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// Owns the workstation's Supabase session for the whole life of the
/// process: the one place that refreshes tokens and the one place that
/// writes session.json.
///
/// ROOT CAUSE this replaces (Will, 2026-10-03: "people are having to sign
/// in 1-2 times a day per workstation"): Supabase refresh tokens ROTATE —
/// every refresh invalidates the token it used, and re-presenting an
/// already-used token (outside a 10 s grace window) makes GoTrue revoke
/// the whole session. The old code persisted the refresh token exactly
/// twice (interactive sign-in, startup restore) while the SDK's own
/// AutoRefreshToken timer silently rotated it again every ~hour in
/// memory — so after the first refresh, session.json held a dead token
/// and the next app restart tripped reuse detection. The embedded
/// WebView2 was also handed the SAME refresh token and rotated it on its
/// own supabase-js timer. See SupabaseAuthService / App.xaml.cs for the
/// rest of the fix.
///
/// Guarantees:
///  - ONE in-flight refresh at a time (SemaphoreSlim); callers that wait
///    re-check "is a refresh still needed?" after acquiring it, so ten
///    concurrent requests produce exactly one network refresh.
///  - The rotated pair is persisted (DPAPI, atomic) BEFORE the refresh
///    gate is released and before anyone can use it.
///  - 90-day ceiling measured from the last interactive sign-in
///    (SessionExpiry), enforced here on every restore/refresh.
///  - Only a DEFINITIVE rejection (Rejected) ends the session and clears
///    session.json; transient failures keep everything and retry later.
/// </summary>
public sealed class SessionKeeper
{
    /// <summary>Refresh once the access token has less than this left (or
    /// its expiry can't be read). Well inside the token's ~1 h life so a
    /// request never goes out with a token about to die.</summary>
    public static readonly TimeSpan RefreshSkew = TimeSpan.FromMinutes(5);

    /// <summary>Waits between startup-restore attempts when the service
    /// can't be reached (so up to 3 tries). Injectable delay keeps tests
    /// instant.</summary>
    public static readonly TimeSpan[] DefaultRestoreRetryDelays = { TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(3) };

    private readonly ISessionStore _store;
    private readonly ISupabaseTokenEndpoint _endpoint;
    private readonly Func<DateTime> _utcNow;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private readonly TimeSpan[] _restoreRetryDelays;
    private readonly Action<string>? _log;

    private readonly SemaphoreSlim _refreshGate = new(1, 1);
    private readonly object _stateLock = new();

    private string? _accessToken;
    private string? _refreshToken;
    private DateTime _issuedAtUtc;
    private string? _lastPersistedRefreshToken;

    public SessionKeeper(
        ISessionStore store,
        ISupabaseTokenEndpoint endpoint,
        Func<DateTime>? utcNow = null,
        Func<TimeSpan, CancellationToken, Task>? delay = null,
        TimeSpan[]? restoreRetryDelays = null,
        Action<string>? log = null)
    {
        _store = store;
        _endpoint = endpoint;
        _utcNow = utcNow ?? (() => DateTime.UtcNow);
        _delay = delay ?? ((span, token) => Task.Delay(span, token));
        _restoreRetryDelays = restoreRetryDelays ?? DefaultRestoreRetryDelays;
        _log = log;
    }

    /// <summary>Raised (synchronously, after the rotated pair is already
    /// persisted and the refresh gate released) whenever a refresh
    /// produced a new access token — App.xaml.cs forwards it to the
    /// embedded WebView2 so the page never has to refresh by itself.</summary>
    public event EventHandler<string>? AccessTokenRefreshed;

    public string? AccessToken
    {
        get { lock (_stateLock) { return _accessToken; } }
    }

    public string? RefreshToken
    {
        get { lock (_stateLock) { return _refreshToken; } }
    }

    public bool HasSession => AccessToken is not null;

    /// <summary>A fresh interactive sign-in: starts a new 90-day window
    /// and persists it.</summary>
    public void StartInteractiveSession(string accessToken, string refreshToken)
    {
        Commit(accessToken, refreshToken, _utcNow());
    }

    /// <summary>
    /// Startup restore from a stored session. Success means the keeper now
    /// holds a usable access token (fast path: the stored one still has
    /// life left, no network at all; otherwise it is refreshed, with
    /// retry/backoff on transient failures). Failure is either
    /// Rejected-style (session ended and session.json cleared) or
    /// IsTransient (nothing cleared — the saved sign-in is intact).
    /// </summary>
    public async Task<AuthResult> RestoreAsync(PersistedSession persisted, CancellationToken cancellationToken = default)
    {
        if (!SessionExpiry.IsValid(persisted.IssuedAtUtc, _utcNow()))
        {
            EndSession("90-day limit reached");
            return AuthResult.Fail("Your saved sign-in is older than 90 days — please sign in again.");
        }

        lock (_stateLock)
        {
            _accessToken = persisted.AccessToken;
            _refreshToken = persisted.RefreshToken;
            _issuedAtUtc = persisted.IssuedAtUtc;
            _lastPersistedRefreshToken = persisted.RefreshToken;
        }

        for (var attempt = 0; ; attempt++)
        {
            var step = await RefreshIfNeededAsync(cancellationToken).ConfigureAwait(false);
            switch (step)
            {
                case RefreshStep.NotNeeded:
                case RefreshStep.Refreshed:
                    return AuthResult.Ok();

                case RefreshStep.Rejected:
                    return AuthResult.Fail("Your saved sign-in is no longer valid — please sign in again.");

                case RefreshStep.Transient:
                    if (attempt >= _restoreRetryDelays.Length)
                    {
                        // Keep session.json (the token is still good) but
                        // don't claim to be signed in with a stale token.
                        ClearMemory();
                        return AuthResult.TransientFail("Couldn't reach the sign-in service.");
                    }

                    _log?.Invoke($"session restore: service unreachable, retry {attempt + 1}/{_restoreRetryDelays.Length}");
                    await _delay(_restoreRetryDelays[attempt], cancellationToken).ConfigureAwait(false);
                    break;
            }
        }
    }

    /// <summary>
    /// The access token to put on an outgoing request. Refreshes first if
    /// it is (nearly) expired — serialized, so concurrent callers share
    /// one refresh. Returns null when there is no session (never signed
    /// in, signed out, or the session ended); returns the current token
    /// unchanged when a refresh failed transiently (the request will
    /// simply fail on its own if the network really is down).
    /// </summary>
    public async Task<string?> GetValidAccessTokenAsync(CancellationToken cancellationToken = default)
    {
        await RefreshIfNeededAsync(cancellationToken).ConfigureAwait(false);
        return AccessToken;
    }

    /// <summary>Local sign-out: forgets the session, deletes session.json,
    /// and (best effort) tells Supabase to end THIS session only.</summary>
    public async Task SignOutAsync(CancellationToken cancellationToken = default)
    {
        var accessToken = AccessToken;
        ClearMemory();
        _store.Delete();

        if (!string.IsNullOrEmpty(accessToken))
        {
            await _endpoint.LogoutLocalAsync(accessToken, cancellationToken).ConfigureAwait(false);
        }
    }

    private enum RefreshStep
    {
        NotNeeded,
        Refreshed,
        Rejected,
        Transient,
    }

    private bool NeedsRefresh()
    {
        string? accessToken;
        lock (_stateLock)
        {
            if (_refreshToken is null)
            {
                return false; // no session at all
            }

            accessToken = _accessToken;
        }

        var expiry = JwtExpiry.TryGetExpiryUtc(accessToken);
        return expiry is null || expiry.Value - _utcNow() <= RefreshSkew;
    }

    private async Task<RefreshStep> RefreshIfNeededAsync(CancellationToken cancellationToken)
    {
        if (!NeedsRefresh())
        {
            return RefreshStep.NotNeeded;
        }

        string? newAccessToken = null;
        RefreshStep step;

        await _refreshGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            // The serialization point: whoever held the gate before us may
            // already have rotated the token — never spend (and so
            // invalidate) a refresh token that is already gone.
            AdoptStoredSessionIfAnotherProcessRotatedIt();
            if (!NeedsRefresh())
            {
                return RefreshStep.NotNeeded;
            }

            string refreshToken;
            DateTime issuedAtUtc;
            lock (_stateLock)
            {
                refreshToken = _refreshToken!;
                issuedAtUtc = _issuedAtUtc;
            }

            if (!SessionExpiry.IsValid(issuedAtUtc, _utcNow()))
            {
                EndSession("90-day limit reached");
                return RefreshStep.Rejected;
            }

            var result = await _endpoint.RefreshAsync(refreshToken, cancellationToken).ConfigureAwait(false);
            switch (result.Kind)
            {
                case TokenRefreshKind.Success:
                    // Persist the rotated pair BEFORE releasing the gate.
                    Commit(result.AccessToken!, result.RefreshToken!, issuedAtUtc);
                    newAccessToken = result.AccessToken;
                    step = RefreshStep.Refreshed;
                    break;

                case TokenRefreshKind.Rejected:
                    EndSession($"refresh rejected ({result.Detail})");
                    step = RefreshStep.Rejected;
                    break;

                default:
                    _log?.Invoke($"token refresh failed transiently ({result.Detail}) — keeping stored session");
                    step = RefreshStep.Transient;
                    break;
            }
        }
        finally
        {
            _refreshGate.Release();
        }

        if (newAccessToken is not null)
        {
            try
            {
                AccessTokenRefreshed?.Invoke(this, newAccessToken);
            }
            catch (Exception ex)
            {
                _log?.Invoke($"AccessTokenRefreshed handler failed ({ex.GetType().Name})");
            }
        }

        return step;
    }

    /// <summary>A second app instance (or a double-launch) may have
    /// rotated the token and saved it since we last wrote. Our in-memory
    /// refresh token is then already spent — use the stored one instead of
    /// presenting a used token (which GoTrue treats as theft). Only
    /// adopts a stored token that is neither ours nor the last one WE
    /// wrote, so a failed save of ours is never "rolled back" onto an
    /// older, already-used token.</summary>
    private void AdoptStoredSessionIfAnotherProcessRotatedIt()
    {
        PersistedSession? stored;
        try
        {
            stored = _store.Load();
        }
        catch (Exception)
        {
            return;
        }

        if (stored is null)
        {
            return;
        }

        lock (_stateLock)
        {
            if (_refreshToken is null ||
                stored.RefreshToken == _refreshToken ||
                stored.RefreshToken == _lastPersistedRefreshToken)
            {
                return;
            }

            _accessToken = stored.AccessToken;
            _refreshToken = stored.RefreshToken;
            _issuedAtUtc = stored.IssuedAtUtc;
            _lastPersistedRefreshToken = stored.RefreshToken;
        }

        _log?.Invoke("adopted a newer stored session written by another app instance");
    }

    private void Commit(string accessToken, string refreshToken, DateTime issuedAtUtc)
    {
        lock (_stateLock)
        {
            _accessToken = accessToken;
            _refreshToken = refreshToken;
            _issuedAtUtc = issuedAtUtc;
        }

        // Two attempts: losing this write after the server already
        // rotated the token is exactly the "signed out after a restart"
        // failure, so one retry is worth it.
        for (var attempt = 0; attempt < 2; attempt++)
        {
            try
            {
                _store.Save(new PersistedSession(accessToken, refreshToken, issuedAtUtc));
                lock (_stateLock)
                {
                    _lastPersistedRefreshToken = refreshToken;
                }

                return;
            }
            catch (Exception ex)
            {
                _log?.Invoke($"could not persist the session (attempt {attempt + 1}): {ex.GetType().Name}");
            }
        }
    }

    private void ClearMemory()
    {
        lock (_stateLock)
        {
            _accessToken = null;
            _refreshToken = null;
            _lastPersistedRefreshToken = null;
        }
    }

    private void EndSession(string reason)
    {
        _log?.Invoke($"session ended: {reason}");
        ClearMemory();
        _store.Delete();
    }
}
