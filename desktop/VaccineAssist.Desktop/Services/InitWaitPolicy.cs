using System;

namespace VaccineAssist.Desktop.Services;

/// <summary>What CloudPageView.EnsureInitializedAsync should do at a given
/// point while it's waiting on WebView2 to start.</summary>
public enum InitWaitAction
{
    /// <summary>Keep waiting silently — still under the hint delay.</summary>
    KeepWaiting,

    /// <summary>Past the hint delay but under the timeout — show the
    /// "Starting the embedded browser…" status text.</summary>
    ShowStartingHint,

    /// <summary>Past the timeout — show the failure panel, but keep
    /// observing the abandoned init task for a late success (see
    /// CloudPageView.ObserveLateInitCompletion).</summary>
    TimedOut,
}

/// <summary>
/// Pure timing policy extracted out of CloudPageView.EnsureInitializedAsync
/// so the "show a hint after N seconds / give up after M seconds" boundary
/// math is unit-testable without WebView2, WPF, or real timers.
///
/// TIMEOUT FIX (Will, 2026-09-16 — "Couldn't load this page" /
/// TimeoutException on a workstation whose WebView2 Evergreen runtime
/// start was slower than the original 12s cap, especially right after a
/// rebuild with a cold %LocalAppData%\VaccineAssist\webview2 user-data
/// folder): the cap moves from 12s to <see cref="Timeout"/> (45s), and a
/// wait longer than <see cref="HintDelay"/> (3s) now shows an in-place
/// "Starting the embedded browser…" status instead of leaving the page
/// looking blank/frozen the whole time.
/// </summary>
public static class InitWaitPolicy
{
    /// <summary>How long to wait silently before showing the "Starting the
    /// embedded browser…" hint.</summary>
    public static readonly TimeSpan HintDelay = TimeSpan.FromSeconds(3);

    /// <summary>Total cap on WebView2 environment + EnsureCoreWebView2Async
    /// combined before this is treated as a failure and the failure panel
    /// is shown (the abandoned attempt keeps running in the background —
    /// see CloudPageView.ObserveLateInitCompletion for what happens if it
    /// later succeeds anyway).</summary>
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(45);

    /// <summary>Pure boundary check: given how long EnsureInitializedAsync
    /// has been waiting, what should it do right now? Both bounds are
    /// inclusive on their "later" side — exactly <see cref="HintDelay"/>
    /// already shows the hint, exactly <see cref="Timeout"/> already times
    /// out — matching how CloudPageView's Task.Delay-based race resolves
    /// once a delay task's Task.WhenAny slot completes.</summary>
    public static InitWaitAction Evaluate(TimeSpan elapsed)
    {
        if (elapsed >= Timeout)
        {
            return InitWaitAction.TimedOut;
        }

        if (elapsed >= HintDelay)
        {
            return InitWaitAction.ShowStartingHint;
        }

        return InitWaitAction.KeepWaiting;
    }
}
