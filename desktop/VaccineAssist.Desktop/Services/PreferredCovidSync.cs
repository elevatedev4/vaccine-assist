using System;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Logging;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.Settings;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// Keeps the desktop's C-hotkey COVID choice (AppSettings.PreferredCovidAdult)
/// following the cloud setting the website edits (/api/settings/preferred-covid).
///
/// SAFETY: a hotkey must never block or break. Nothing here is awaited on the
/// hotkey path - callers fire RefreshIfStaleAsync() and keep using the local
/// value; a refresh that lands applies from then on. Every failure (offline,
/// 401, 404, timeout, bad payload) is logged and swallowed, and the local value
/// stays. The public methods never throw.
///
/// Rules:
///  - A successful refresh is cached CacheWindow (60 s); a failed one retries
///    after FailureRetryWindow; one refresh runs at a time; each cloud call is
///    capped at RequestTimeout (3 s) - the cap covers only that call, auth
///    token refreshes inside VaccineApiService are never cancelled by it.
///  - FIRST RUN (settings.PreferredCovidSynced == false): if the cloud says it
///    has a stored value (saved:true) adopt it; if it says saved:false or does
///    not say (older cloud) seed the cloud with the local value instead of
///    pulling, so the cloud's never-saved default can't flip a local choice.
///    Either success sets PreferredCovidSynced; after that the cloud wins.
///  - A tray pick goes through MarkLocalPick (records it as unsynced and bumps
///    the version under the lock, BEFORE the setting changes) so a refresh
///    already in flight can never overwrite it, then PushPendingAsync PUTs it.
///    The unsynced pick lives in settings.json and is retried (before any pull)
///    until the cloud confirms - including across restarts. A PUT answered
///    pending:true is NOT confirmation.
/// </summary>
public sealed class PreferredCovidSync
{
    public static readonly TimeSpan CacheWindow = TimeSpan.FromSeconds(60);
    public static readonly TimeSpan FailureRetryWindow = TimeSpan.FromSeconds(15);
    public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(3);

    private readonly IPreferredCovidApi _api;
    private readonly AppSettings _settings;
    private readonly Action _stateChanged;
    private readonly Func<DateTimeOffset> _now;
    private readonly TimeSpan _timeout;
    private readonly object _gate = new();
    private readonly SemaphoreSlim _pushGate = new(1, 1);

    private DateTimeOffset _nextRefreshAt = DateTimeOffset.MinValue;
    private Task? _refreshInFlight;
    private int _localVersion;

    /// <param name="settings">The live settings object; this class reads and writes PreferredCovidAdult / PreferredCovidSynced / PreferredCovidUnsyncedAdult.</param>
    /// <param name="stateChanged">Called after a change to those settings (cloud adopted, pick recorded, sync state flipped): the caller saves settings.json and refreshes the tray check from settings.PreferredCovidAdult. May run on a thread-pool thread.</param>
    /// <param name="now">Test seam for the cache window.</param>
    /// <param name="timeout">Test seam; defaults to RequestTimeout.</param>
    public PreferredCovidSync(
        IPreferredCovidApi api,
        AppSettings settings,
        Action stateChanged,
        Func<DateTimeOffset>? now = null,
        TimeSpan? timeout = null)
    {
        _api = api;
        _settings = settings;
        _stateChanged = stateChanged;
        _now = now ?? (() => DateTimeOffset.UtcNow);
        _timeout = timeout ?? RequestTimeout;
    }

    /// <summary>
    /// Pulls (or, first run, seeds) unless one was tried recently or a refresh is
    /// already running. The returned task completes when the attempt is done
    /// (hotkey-path callers ignore it). Never throws.
    /// </summary>
    public Task RefreshIfStaleAsync()
    {
        lock (_gate)
        {
            if (_refreshInFlight is { IsCompleted: false })
            {
                return _refreshInFlight;
            }

            if (_now() < _nextRefreshAt)
            {
                return Task.CompletedTask;
            }

            _refreshInFlight = Task.Run(RefreshCoreAsync);
            return _refreshInFlight;
        }
    }

    /// <summary>
    /// A tray pick, step 1 (synchronous, UI thread): record it as unsynced and bump
    /// the version FIRST, then set PreferredCovidAdult - all under the lock a
    /// refresh's apply step takes - so an in-flight refresh can't overwrite it.
    /// The caller then saves settings.json and calls PushPendingAsync.
    /// </summary>
    public void MarkLocalPick(string adult)
    {
        var normalized = PreferredCovidSetting.NormalizeAdult(adult) ?? PreferredCovidSetting.AdultPfizer;
        lock (_gate)
        {
            _settings.PreferredCovidUnsyncedAdult = normalized;
            _localVersion++;
            _settings.PreferredCovidAdult = normalized;
        }
    }

    /// <summary>
    /// PUTs the unsynced pick (if any) to the cloud. Failures, timeouts and a
    /// pending:true answer are logged and leave it unsynced for the next refresh.
    /// Pushes are serialized and always send the newest pick. Never throws.
    /// </summary>
    public async Task PushPendingAsync()
    {
        try
        {
            await _pushGate.WaitAsync().ConfigureAwait(false);
            try
            {
                await PushLockedAsync().ConfigureAwait(false);
            }
            finally
            {
                _pushGate.Release();
            }
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("PreferredCovidSync.Push", ex);
            MarkAttempt(FailureRetryWindow);
        }
    }

    private async Task PushLockedAsync()
    {
        string? adult;
        lock (_gate)
        {
            adult = _settings.PreferredCovidUnsyncedAdult;
        }

        if (adult is null)
        {
            return;
        }

        bool stored;
        try
        {
            stored = await WithTimeout(ct => _api.SetPreferredCovidAsync(adult, PreferredCovidSetting.KidsModerna, ct)).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("PreferredCovidSync.Push", ex);
            MarkAttempt(FailureRetryWindow);
            return;
        }

        if (!stored)
        {
            // Cloud setting table not created yet: not confirmed - keep the pick, keep retrying.
            AppFileLog.Log("[Settings] preferred COVID: cloud setting not available yet (pending); will retry");
            MarkAttempt(FailureRetryWindow);
            return;
        }

        lock (_gate)
        {
            // Only clear if the user has not picked something newer meanwhile.
            if (_settings.PreferredCovidUnsyncedAdult == adult)
            {
                _settings.PreferredCovidUnsyncedAdult = null;
            }

            _settings.PreferredCovidSynced = true;
        }

        _stateChanged();
        MarkAttempt(CacheWindow);
    }

    private async Task RefreshCoreAsync()
    {
        try
        {
            bool hasUnsynced;
            int versionBefore;
            lock (_gate)
            {
                hasUnsynced = _settings.PreferredCovidUnsyncedAdult is not null;
                versionBefore = _localVersion;
            }

            if (hasUnsynced)
            {
                // The local pick never reached the cloud - finish that first; pulling now would undo it.
                await PushPendingAsync().ConfigureAwait(false);
                return;
            }

            var remote = await WithTimeout(ct => _api.GetPreferredCovidAsync(ct)).ConfigureAwait(false);
            var remoteAdult = PreferredCovidSetting.NormalizeAdult(remote?.Adult);
            if (remote is null || remoteAdult is null)
            {
                // Nothing usable to follow (cloud setting pending / unrecognized): keep local, not synced.
                MarkAttempt(CacheWindow);
                return;
            }

            var seed = false;
            var changed = false;
            lock (_gate)
            {
                // A tray pick that happened while this request was out wins over its (older) answer.
                if (_localVersion != versionBefore || _settings.PreferredCovidUnsyncedAdult is not null)
                {
                    MarkAttemptLocked(CacheWindow);
                    return;
                }

                if (!_settings.PreferredCovidSynced && !remote.Saved)
                {
                    // First run and the cloud only has its never-saved default (or is an older
                    // version that can't say): seed it with our value instead of adopting that default.
                    _settings.PreferredCovidUnsyncedAdult = PreferredCovidSetting.NormalizeAdult(_settings.PreferredCovidAdult) ?? PreferredCovidSetting.AdultPfizer;
                    seed = true;
                }
                else
                {
                    var localAdult = PreferredCovidSetting.NormalizeAdult(_settings.PreferredCovidAdult) ?? PreferredCovidSetting.AdultPfizer;
                    if (remoteAdult != localAdult)
                    {
                        AppFileLog.Log($"[Settings] preferred COVID (12+) follows the website: {localAdult} -> {remoteAdult}");
                        _settings.PreferredCovidAdult = remoteAdult;
                        changed = true;
                    }

                    if (!_settings.PreferredCovidSynced)
                    {
                        _settings.PreferredCovidSynced = true;
                        changed = true;
                    }
                }
            }

            if (seed)
            {
                AppFileLog.Log("[Settings] preferred COVID: cloud has no saved value yet; seeding it with this machine's choice");
                _stateChanged();
                await PushPendingAsync().ConfigureAwait(false);
                return;
            }

            if (changed)
            {
                _stateChanged();
            }

            MarkAttempt(CacheWindow);
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("PreferredCovidSync.Refresh", ex);
            MarkAttempt(FailureRetryWindow);
        }
    }

    private void MarkAttempt(TimeSpan window)
    {
        lock (_gate)
        {
            MarkAttemptLocked(window);
        }
    }

    private void MarkAttemptLocked(TimeSpan window) => _nextRefreshAt = _now() + window;

    /// <summary>Runs one cloud call under the request timeout - a cancellation token (the real HttpClient honors it) plus a hard wait, so a call that ignores its token still cannot hang past the limit.</summary>
    private async Task<T> WithTimeout<T>(Func<CancellationToken, Task<T>> call)
    {
        using var cts = new CancellationTokenSource(_timeout);
        return await call(cts.Token).WaitAsync(_timeout).ConfigureAwait(false);
    }
}
