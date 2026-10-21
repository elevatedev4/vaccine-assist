using System;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// The ONE retry mechanism for the lockable Windows clipboard: a single
/// attempt is made through NativeClipboard (instant, no hidden WPF retry), and
/// attempts repeat every <see cref="DefaultDelay"/> until one succeeds or the
/// total <see cref="DefaultBudget"/> (about 1 s) is used up. Outage
/// 2026-10-20 suspect: stacked retries (6 x 100 ms on top of WPF's own ~1 s
/// retry per call) could freeze the UI thread for many seconds. Pure (the
/// attempt, the wait and the clock are injected) so it is unit tested without
/// WPF. Never throws; the async form never blocks the UI thread while waiting.
/// </summary>
public static class ClipboardRetry
{
    public const int DefaultAttempts = 20;
    public static readonly TimeSpan DefaultDelay = TimeSpan.FromMilliseconds(50);

    /// <summary>Total time any clipboard operation may take, waits included.</summary>
    public static readonly TimeSpan DefaultBudget = TimeSpan.FromSeconds(1);

    /// <summary>True once <paramref name="attempt"/> succeeds; false when every attempt threw or the budget ran out. Blocks the calling thread for at most about the budget.</summary>
    public static bool TryRun(
        Action attempt,
        int attempts = DefaultAttempts,
        TimeSpan? delay = null,
        TimeSpan? budget = null,
        Action<TimeSpan>? sleep = null,
        Func<TimeSpan>? elapsed = null,
        Action<int, Exception>? onFailure = null)
    {
        var pause = delay ?? DefaultDelay;
        var limit = budget ?? DefaultBudget;
        sleep ??= Thread.Sleep;
        var clock = elapsed ?? StartClock();
        for (var n = 1; n <= Math.Max(1, attempts); n++)
        {
            try
            {
                attempt();
                return true;
            }
            catch (Exception ex)
            {
                onFailure?.Invoke(n, ex);
                if (n >= attempts || clock() + pause >= limit)
                {
                    return false;
                }

                sleep(pause);
            }
        }

        return false;
    }

    /// <summary>Same as <see cref="TryRun"/> for a setter of <paramref name="text"/>.</summary>
    public static bool TrySet(
        Action<string> set,
        string text,
        int attempts = DefaultAttempts,
        TimeSpan? delay = null,
        TimeSpan? budget = null,
        Action<TimeSpan>? sleep = null,
        Func<TimeSpan>? elapsed = null,
        Action<int, Exception>? onFailure = null) =>
        TryRun(() => set(text), attempts, delay, budget, sleep, elapsed, onFailure);

    /// <summary>True once <paramref name="set"/> succeeds; false after every attempt threw or the budget ran out. Never throws; waits with Task.Delay so the UI thread stays free.</summary>
    public static async Task<bool> TrySetAsync(
        Action<string> set,
        string text,
        int attempts = DefaultAttempts,
        TimeSpan? delay = null,
        Func<TimeSpan, Task>? wait = null,
        Action<int, Exception>? onFailure = null,
        TimeSpan? budget = null,
        Func<TimeSpan>? elapsed = null)
    {
        var pause = delay ?? DefaultDelay;
        var limit = budget ?? DefaultBudget;
        wait ??= Task.Delay;
        var clock = elapsed ?? StartClock();
        for (var attempt = 1; attempt <= Math.Max(1, attempts); attempt++)
        {
            try
            {
                set(text);
                return true;
            }
            catch (Exception ex)
            {
                onFailure?.Invoke(attempt, ex);
                if (attempt >= attempts || clock() + pause >= limit)
                {
                    return false;
                }

                await wait(pause);
            }
        }

        return false;
    }

    private static Func<TimeSpan> StartClock()
    {
        var watch = Stopwatch.StartNew();
        return () => watch.Elapsed;
    }
}
