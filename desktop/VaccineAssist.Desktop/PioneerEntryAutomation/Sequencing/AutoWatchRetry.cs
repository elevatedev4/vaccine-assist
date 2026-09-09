using System;
using System.Threading;
using System.Threading.Tasks;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;

/// <summary>
/// V-T28: retries a single synchronous, possibly-throwing UIA/FlaUI call
/// ("attempt") against an OVERALL WALL-CLOCK budget whenever it fails with
/// an AutoWatchErrorClassifier.IsRecoverable exception (TimeoutException /
/// a COM timeout HRESULT / "timed out" in the message) — see that class's
/// doc comment for the full root-cause writeup. Before this, every
/// single-shot live UIA call on the auto-watch path (SendF3AndDismissPreEntryDialogsStep's
/// F3 send, QuickSearchFieldEntry's SetValue/FocusNative/ENTER) had exactly
/// ONE attempt: a transient "PioneerRx didn't respond to this one UIA call
/// in time" failed the whole step (and, since PioneerEntrySequenceRunner
/// stops at the first failed step, the whole entry) immediately.
///
/// Deliberately measures WALL-CLOCK elapsed time against `overallBudget`,
/// not a tick/attempt count — unlike this step's OWN
/// DismissPendingDialogsAsync/DismissAllStrayWindowsAsync/WaitForAsync
/// (which count consecutive EMPTY polls of a "is X here YET" question),
/// this is retrying an operation that ITSELF failed with an exception, so
/// "how long have we actually been stuck" is the only budget that makes
/// sense here.
///
/// A NON-recoverable exception is never caught here at all (no `catch`
/// clause matches it, thanks to the `when` filter) — it propagates straight
/// out of `attempt()` to the caller's own existing try/catch, completely
/// unchanged from the pre-V-T28 behavior. Only a RECOVERABLE exception that
/// is STILL happening once `overallBudget` has elapsed is (re)thrown — same
/// exception, same type, same message — so a caller's existing catch clause
/// keeps working without having to know or care that a retry ever
/// happened; it only sees more time pass and (optionally) `onRecoverableWait`
/// callbacks in between.
///
/// PURE aside from the injected `now`/`onRecoverableWait` delegates — no
/// FlaUI/UIA dependency of its own, drivable by a fake clock and a no-op
/// wait in tests, same "pure polling primitive, real waits injected by the
/// live caller" pattern as SendF3AndDismissPreEntryDialogsStep's own
/// DismissPendingDialogsAsync/DismissAllStrayWindowsAsync/WaitForAsync —
/// see AutoWatchRetryTests.cs.
/// </summary>
public static class AutoWatchRetry
{
    /// <summary>Default overall wall-clock budget for a single retried
    /// operation once it starts timing out — Will's brief, verbatim:
    /// "keep polling up to an overall configurable budget (default 60s, up
    /// from whatever it is now)" (there was no retry budget at all before
    /// V-T28; a single raw TimeoutException failed the whole step
    /// immediately, i.e. the effective budget was 0s). Not a `const` so a
    /// future settings screen could override it without an API break —
    /// same "public mutable default" shape as
    /// SendF3AndDismissPreEntryDialogsStep.CombinedDialogsTimeout would be
    /// if it weren't `readonly` (this one deliberately isn't, for that
    /// reason).</summary>
    public static TimeSpan DefaultOverallBudget = TimeSpan.FromSeconds(60);

    /// <summary>
    /// Runs `attempt`, retrying it for as long as it keeps failing with a
    /// recoverable exception (see class doc) and the wall-clock elapsed
    /// since the first attempt (per `now`) is still under `overallBudget`.
    /// `onRecoverableWait` is awaited once per recoverable failure (never
    /// after the final, budget-exhausted failure) — the live caller uses it
    /// to log "still waiting on X after Ns" (V-T28's "log the wait target +
    /// elapsed" ask) and to actually pause (e.g. Task.Delay) before the
    /// next attempt; a test passes a no-op logger and an instantly-resolving
    /// Task plus a fake `now` that advances the clock, so this never
    /// actually sleeps in xUnit.
    /// </summary>
    public static async Task<T> RunAsync<T>(
        Func<T> attempt,
        TimeSpan overallBudget,
        Func<DateTime> now,
        Func<Exception, TimeSpan, Task> onRecoverableWait,
        CancellationToken cancellationToken = default)
    {
        var start = now();

        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();

            try
            {
                return attempt();
            }
            catch (Exception ex) when (AutoWatchErrorClassifier.IsRecoverable(ex))
            {
                var elapsed = now() - start;
                if (elapsed >= overallBudget)
                {
                    // Budget exhausted — rethrow the SAME exception (not a
                    // wrapper) so the caller's existing catch clause sees
                    // exactly what it always saw, just later.
                    throw;
                }

                await onRecoverableWait(ex, elapsed);
            }
        }
    }
}
