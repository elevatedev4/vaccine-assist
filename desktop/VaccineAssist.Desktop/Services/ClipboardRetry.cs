using System;
using System.Threading.Tasks;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// The Windows clipboard is a shared, lockable resource: another app holding
/// it makes Clipboard.SetText throw (COMException CLIPBRD_E_CANT_OPEN). This
/// retries a few times before giving up, so a momentary lock is not treated
/// as a failure. Pure (the setter and the wait are injected) so it is unit
/// tested without WPF.
/// </summary>
public static class ClipboardRetry
{
    public const int DefaultAttempts = 6;
    public static readonly TimeSpan DefaultDelay = TimeSpan.FromMilliseconds(100);

    /// <summary>True once <paramref name="set"/> succeeds; false after every attempt threw. Never throws. <paramref name="onFailure"/> gets each exception (for logging).</summary>
    public static async Task<bool> TrySetAsync(
        Action<string> set,
        string text,
        int attempts = DefaultAttempts,
        TimeSpan? delay = null,
        Func<TimeSpan, Task>? wait = null,
        Action<int, Exception>? onFailure = null)
    {
        var pause = delay ?? DefaultDelay;
        wait ??= Task.Delay;
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
                if (attempt < attempts)
                {
                    await wait(pause);
                }
            }
        }

        return false;
    }
}
