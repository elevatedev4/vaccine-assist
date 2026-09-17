using System;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// Timing constants for CloudPageView.EnsureInitializedAsync's WebView2
/// init wait — pulled out to one place so the "show a hint after N
/// seconds / give up after M seconds" values are named, tested, and easy
/// to find, rather than being magic numbers inline.
///
/// TIMEOUT FIX (Will, 2026-09-16 — "Couldn't load this page" /
/// TimeoutException on a workstation whose WebView2 Evergreen runtime
/// start was slower than the original 12s cap, especially right after a
/// rebuild with a cold %LocalAppData%\VaccineAssist\webview2 user-data
/// folder): the cap moves from 12s to <see cref="Timeout"/> (45s), and a
/// wait longer than <see cref="HintDelay"/> (3s) now shows an in-place
/// "Starting the embedded browser…" status instead of leaving the page
/// looking blank/frozen the whole time.
///
/// REVIEW FIX (2026-09-16, non-blocking): this used to also expose an
/// Evaluate(elapsed) boundary function returning a KeepWaiting/
/// ShowStartingHint/TimedOut enum, but CloudPageView's actual wait is a
/// three-way Task.WhenAny race (initTask vs. two Task.Delay tasks), never
/// a polled "how much time has passed" loop — Evaluate had no caller and
/// was dead code. Removed in favor of just these two constants, which
/// EnsureInitializedAsync uses directly to build its Task.Delay calls.
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
}
