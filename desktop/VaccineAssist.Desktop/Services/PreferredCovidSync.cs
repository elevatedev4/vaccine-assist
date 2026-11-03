using System;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Logging;
using VaccineAssist.Desktop.Models;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// Keeps the desktop's C-hotkey COVID choice (AppSettings.PreferredCovidAdult)
/// following the cloud setting the website edits (/api/settings/preferred-covid).
///
/// SAFETY: a hotkey must never block or break. Nothing here is awaited on the
/// hotkey path - callers fire RefreshIfStaleAsync() and keep using the local
/// value; a refresh that lands applies from then on. Every failure (offline,
/// 401, 404, timeout, bad payload) is logged and swallowed, and the local value
/// stays. Neither public method ever throws.
///
/// Rules: a successful refresh is cached CacheWindow (60 s); a failed one
/// retries after FailureRetryWindow; one request in flight at a time; each call
/// times out after RequestTimeout (3 s). A tray pick is saved locally by the
/// caller first, then pushed here; if the push fails it is retried on the next
/// refresh (instead of the cloud's older value overwriting the pick).
/// </summary>
public sealed class PreferredCovidSync
{
    public static readonly TimeSpan CacheWindow = TimeSpan.FromSeconds(60);
    public static readonly TimeSpan FailureRetryWindow = TimeSpan.FromSeconds(15);
    public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(3);

    private readonly IPreferredCovidApi _api;
    private readonly Func<string?> _getLocalAdult;
    private readonly Action<string> _applyRemoteAdult;
    private readonly Func<DateTimeOffset> _now;
    private readonly TimeSpan _timeout;
    private readonly object _gate = new();

    private DateTimeOffset _nextRefreshAt = DateTimeOffset.MinValue;
    private Task? _refreshInFlight;
    private string? _unsyncedAdult;
    private int _localVersion;

    /// <param name="getLocalAdult">Current local value (AppSettings.PreferredCovidAdult).</param>
    /// <param name="applyRemoteAdult">Called with "pfizer"/"moderna" when the cloud differs from the local value; the caller saves it and refreshes the tray. May run on a thread-pool thread.</param>
    /// <param name="now">Test seam for the cache window.</param>
    /// <param name="timeout">Test seam; defaults to RequestTimeout.</param>
    public PreferredCovidSync(
        IPreferredCovidApi api,
        Func<string?> getLocalAdult,
        Action<string> applyRemoteAdult,
        Func<DateTimeOffset>? now = null,
        TimeSpan? timeout = null)
    {
        _api = api;
        _getLocalAdult = getLocalAdult;
        _applyRemoteAdult = applyRemoteAdult;
        _now = now ?? (() => DateTimeOffset.UtcNow);
        _timeout = timeout ?? RequestTimeout;
    }

    /// <summary>
    /// Pulls the cloud value unless one was tried recently or a request is
    /// already running. Returns a task that completes when the attempt is done
    /// (callers on the hotkey path ignore it). Never throws.
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
    /// A tray pick (already saved locally by the caller): push it to the cloud
    /// so the website agrees. Failures are logged and the pick is retried on
    /// the next refresh. Never throws.
    /// </summary>
    public Task PushFromTrayAsync(string adult)
    {
        var normalized = PreferredCovidSetting.NormalizeAdult(adult) ?? PreferredCovidSetting.AdultPfizer;
        lock (_gate)
        {
            _unsyncedAdult = normalized;
            _localVersion++;
        }

        return Task.Run(() => PushAsync(normalized));
    }

    private async Task RefreshCoreAsync()
    {
        try
        {
            string? pending;
            int versionBefore;
            lock (_gate)
            {
                pending = _unsyncedAdult;
                versionBefore = _localVersion;
            }

            if (pending is not null)
            {
                // The local pick never reached the cloud - finish that first; pulling now would undo it.
                await PushAsync(pending).ConfigureAwait(false);
                return;
            }

            var remote = await WithTimeout(ct => _api.GetPreferredCovidAsync(ct)).ConfigureAwait(false);
            if (remote is not null)
            {
                var remoteAdult = PreferredCovidSetting.NormalizeAdult(remote.Adult);
                var localAdult = PreferredCovidSetting.NormalizeAdult(_getLocalAdult()) ?? PreferredCovidSetting.AdultPfizer;
                bool apply;
                lock (_gate)
                {
                    // A tray pick that happened while this request was out wins over its (older) answer.
                    apply = remoteAdult is not null && remoteAdult != localAdult && _localVersion == versionBefore && _unsyncedAdult is null;
                }

                if (apply)
                {
                    AppFileLog.Log($"[Settings] preferred COVID (12+) follows the website: {localAdult} -> {remoteAdult}");
                    _applyRemoteAdult(remoteAdult!);
                }
            }

            MarkAttempt(CacheWindow);
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("PreferredCovidSync.Refresh", ex);
            MarkAttempt(FailureRetryWindow);
        }
    }

    private async Task PushAsync(string adult)
    {
        try
        {
            await WithTimeout(async ct => await _api.SetPreferredCovidAsync(adult, PreferredCovidSetting.KidsModerna, ct).ConfigureAwait(false)).ConfigureAwait(false);
            lock (_gate)
            {
                // Only clear if the user has not picked something newer meanwhile.
                if (_unsyncedAdult == adult)
                {
                    _unsyncedAdult = null;
                }
            }

            MarkAttempt(CacheWindow);
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("PreferredCovidSync.Push", ex);
            MarkAttempt(FailureRetryWindow);
        }
    }

    private void MarkAttempt(TimeSpan window)
    {
        lock (_gate)
        {
            _nextRefreshAt = _now() + window;
        }
    }

    /// <summary>Runs one cloud call under the request timeout - both a cancellation token (the real HttpClient honors it) and a hard wait, so a call that ignores its token still cannot hang past the limit.</summary>
    private async Task<T> WithTimeout<T>(Func<CancellationToken, Task<T>> call)
    {
        using var cts = new CancellationTokenSource(_timeout);
        return await call(cts.Token).WaitAsync(_timeout).ConfigureAwait(false);
    }
}
