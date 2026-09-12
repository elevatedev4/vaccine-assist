using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Conditions;
using FlaUI.Core.Definitions;
using FlaUI.Core.Input;
using FlaUI.Core.WindowsAPI;
using FlaUI.UIA3;
using VaccineAssist.Desktop.Uia;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// Step 2 of PlaceholderVaccineEntrySequence (Will's brief, 2026-09-07,
/// verbatim): "The data entry should start from the patient Rx Profile,
/// not from Add New Rx. So from that profile screen, push F3, then two
/// windows will open that have to be escaped from, Priority, and Scan hard
/// copy... Once on Add New Rx, you successfully got to enter the
/// prescriber and vaccine by NDC..." — i.e. this step is what gets Pioneer
/// FROM the Rx Profile (where FocusPioneerWindowStep attaches) TO the
/// "Add New Rx" screen the rest of the sequence already assumes.
///
/// MSG893 item 2 REWORK (Will, 2026-09-08) — real-world log: "FAILED —
/// F3 was sent, but couldn't find a distinct 'Add New Rx' window to
/// re-attach to ... 'Priority', 'Scan Hard Copy', 'Patient on Cycle Fill'
/// dialog(s) did not appear/dismiss within 8s." Likely truth (per Will's
/// own brief): PioneerRx is a single-window app — "Add New Rx" is a
/// SCREEN inside the same top-level window, not a separately titled
/// window, and the pre-entry dialogs may be UIA child Windows/Panes
/// inside it (or a top-level window that just doesn't carry a title this
/// code recognized) rather than distinctly-titled top-level windows.
/// Dialog dismissal scans BOTH top-level windows OWNED BY THE PIONEER
/// PROCESS (not just any desktop window — see
/// FindTopLevelPioneerWindowByTitle) AND UIA descendants of the attached
/// window with ControlType Window/Pane/Custom (see FindDialogDescendant),
/// matching via PreEntryDialogTitles.MatchesWithAliases (also matches
/// "Cycle Fill" alone). It additionally recognizes ANY top-level Pioneer
/// window that appeared after F3 and isn't the main window as a "stray"
/// dialog worth ESCing even with no recognized title
/// (TryDismissNextStrayPioneerWindow) — logged so an unrecognized dialog
/// is at least visible in the step log instead of silently stalling the
/// whole sequence. Re-attaching to "Add New Rx" no longer requires a
/// DISTINCT window handle: the combined loop below (see
/// RunCombinedPreEntryLoopAsync) accepts EITHER (i) a top-level Pioneer
/// window whose title contains "New Rx" (excluding the pre-F3 window) OR
/// (ii) the SAME window (by handle) now exposing the prescriber/NDC
/// quick-search field the very next two steps already search for
/// (reusing their exact AutomationIds — see HasNextStepField) — matching
/// this being a single-window app where the title may never actually
/// change. A re-attach failure automatically writes a UIA tree dump
/// (reusing UiaTreeDumper — the same "Dump Pioneer UIA tree" button
/// uses) and includes its path in the failure message.
///
/// SPEED REWORK (V-..., 2026-09-10, Will's real app.log: this step took
/// 102s on a live run, vs. its own nominal ~20s worth of timeouts at the
/// time). ROOT CAUSE: the step used to run THREE SEPARATE polling phases
/// back to back — dismiss known dialogs (its own up-to-12s budget), THEN
/// sweep for any stray window (up to another 3s), THEN wait for the
/// resulting Add New Rx screen to show up (up to another 5s) — and each
/// phase ran its OWN maxEmptyTicks budget all the way to completion even
/// when nothing was ever going to show up in it (e.g. the stray-window
/// sweep still paid out its full budget on a machine with no stray window
/// at all, and — the actually expensive part — on EVERY one of those
/// ticks, a fresh live UIA desktop scan ran (a new UIA3Automation +
/// FindAllChildren() walk, real cross-process COM work against a live
/// PioneerRx process, genuinely slow — not a hardcoded sleep anywhere in
/// this file) whether or not it would find anything). Three phases each
/// burning their own worst-case budget, each tick of which costs real
/// wall-clock time well past the nominal 200ms poll interval, is exactly
/// how a nominal ~20s adds up to a real 102s.
///
/// FIX: RunCombinedPreEntryLoopAsync below replaces all three phases with
/// ONE polling loop, at ~250ms nominal cadence, capped at
/// CombinedPreEntryLoopTimeout (~15s) OVERALL rather than per-phase. Every
/// tick FIRST checks whether Add New Rx is already showing (isAddNewRxReady)
/// and returns immediately the instant it is — so a screen that's already
/// ready right after F3 (or right after the very first dialog is
/// dismissed) doesn't sit through any further phase's leftover budget.
/// Only if it isn't ready yet does the loop try to dismiss whatever's in
/// the way (a known dialog first, then a stray window — see
/// TryDismissNextPendingDialogOrStrayWindow), rescanning immediately after
/// a dismissal (no wait — dismissing one thing may reveal Add New Rx, or
/// the next dialog, right away) rather than waiting out a fixed phase
/// timeout regardless of what's actually happening.
///
/// NOT CONFIRMED against a live UIA dump — see PreEntryDialogTitles.cs's
/// own doc comment for exactly what's unconfirmed and why. This step's
/// pure decision logic (dry-run description, guard clauses, title
/// matching, and RunCombinedPreEntryLoopAsync's polling algorithm) is
/// covered by SendF3AndDismissPreEntryDialogsStepTests.cs; the live
/// FlaUI/UIA calls below (like every other step's live branch in this
/// sequence) can only be proven against a real Pioneer install on
/// Windows.
/// </summary>
public sealed class SendF3AndDismissPreEntryDialogsStep : IPioneerEntryStep
{
    /// <summary>V-..., 2026-09-10: ONE overall cap for the whole
    /// post-F3 combined loop (dismiss known/stray dialogs, wait for Add
    /// New Rx) — replaces the old CombinedDialogsTimeout (12s) +
    /// StrayWindowSweepTimeout (3s) + AddNewRxWaitTimeout (5s) three-phase
    /// split. See the class doc comment's SPEED REWORK section for why a
    /// single budget with an early success exit is the actual fix, not
    /// just a smaller number.</summary>
    public static readonly TimeSpan CombinedPreEntryLoopTimeout = TimeSpan.FromSeconds(15);

    /// <summary>V-..., 2026-09-10: widened from 200ms to Will's requested
    /// ~250ms — the exact tick interval barely matters next to the real
    /// fix (one loop with an early exit instead of three unconditional
    /// phases), but this matches the brief verbatim.</summary>
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(250);

    public string Name => "Start Add New Rx (F3) and dismiss pre-entry dialogs";

    public async Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
    {
        if (context.DryRun)
        {
            // Built from PreEntryDialogTitles.All rather than hardcoded
            // (MSG893 hotfix, 2026-09-07-ish) so adding a new recognized
            // dialog there — like "Patient on Cycle Fill" was — can't go
            // stale in this description again.
            var dialogList = string.Join(", ", PreEntryDialogTitles.All.Select(t => $"\"{t}\""));
            return new PioneerEntryStepResult(Name, Success: true, DryRun: true,
                $"Would press F3 from the Rx Profile, then ESC through the {dialogList} dialog(s) if any appear " +
                "(no PioneerRx call made).");
        }

        if (context.AttachedWindow is null)
        {
            return new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                "No PioneerRx window attached — FocusPioneerWindowStep must run (and succeed) before this step.");
        }

        var attachedWindow = context.AttachedWindow;
        var previousHandle = SafeNativeHandle(attachedWindow);
        var baselineHandles = SnapshotPioneerWindowHandles();

        Task WaitTick() => Task.Delay(PollInterval, cancellationToken);

        // V-T28 (Will, 2026-09-09): "Made it to the start of data entry
        // into Pioneer, then error: Unexpected error during auto-watch:
        // Operation timed out. (0x80131505)" — this F3 send used to be a
        // single, unretried attempt: PioneerRx being busy for even one UIA
        // call at exactly this moment (right after the pharmacist switched
        // to the Rx Profile screen — plausibly still rendering) failed the
        // whole step, and the whole entry, immediately. Now retries a
        // recoverable (timeout-shaped — see AutoWatchErrorClassifier)
        // failure for up to AutoWatchRetry.DefaultOverallBudget before
        // giving up; a non-recoverable exception still fails immediately,
        // unchanged from before.
        var f3Stopwatch = Stopwatch.StartNew();
        var f3RetryAttempt = 0;
        try
        {
            await AutoWatchRetry.RunAsync(
                attempt: () =>
                {
                    attachedWindow.FocusNative();
                    Keyboard.Type(VirtualKeyShort.F3);
                    return true;
                },
                overallBudget: AutoWatchRetry.DefaultOverallBudget,
                now: () => DateTime.UtcNow,
                onRecoverableWait: async (ex, elapsed) =>
                {
                    // V-..., 2026-09-11: throttled per
                    // AutoWatchRetry.ShouldLogRetry's own doc comment — same
                    // "still waiting" spam fix as QuickSearchFieldEntry.TypeAndConfirmAsync.
                    f3RetryAttempt++;
                    if (AutoWatchRetry.ShouldLogRetry(f3RetryAttempt))
                    {
                        context.Log($"[{Name}] Still waiting to send F3 to the Rx Profile window after " +
                            $"{elapsed.TotalSeconds:0.0}s — {ex.GetType().Name}: {ex.Message}. PioneerRx may be busy; retrying...");
                    }
                    await WaitTick();
                },
                cancellationToken: cancellationToken);
        }
        catch (Exception ex)
        {
            return AutoWatchErrorClassifier.IsRecoverable(ex)
                ? BuildStalledResult("sending F3 to the Rx Profile window", ex)
                : new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                    $"Couldn't send F3 to the Rx Profile window: {ex.Message}");
        }
        context.Log($"[{Name}] Sent F3 (took {f3Stopwatch.ElapsedMilliseconds}ms).");

        var strayAttempts = new Dictionary<IntPtr, int>();
        AutomationElement? addNewRxWindow = null;

        bool IsAddNewRxReady()
        {
            var found = FindTopLevelPioneerWindowByTitle(name => name.Contains("New Rx", StringComparison.OrdinalIgnoreCase), previousHandle);
            if (found is null)
            {
                var current = TryGetElementFromHandle(previousHandle);
                if (current is not null && HasNextStepField(current)) found = current;
            }
            if (found is null) return false;
            addNewRxWindow = found;
            return true;
        }

        string? TryDismissNext() =>
            TryDismissNextPendingDialogOrStrayWindow(attachedWindow, baselineHandles, previousHandle, strayAttempts);

        var loopStopwatch = Stopwatch.StartNew();
        CombinedPreEntryLoopResult loopResult;
        try
        {
            loopResult = await RunCombinedPreEntryLoopAsync(
                IsAddNewRxReady, TryDismissNext, TicksFor(CombinedPreEntryLoopTimeout), WaitTick, cancellationToken);
        }
        catch (Exception ex)
        {
            return AutoWatchErrorClassifier.IsRecoverable(ex)
                ? BuildStalledResult("waiting for the \"Add New Rx\" screen (dismissing any dialogs in the way)", ex)
                : new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                    $"Error while waiting for the \"Add New Rx\" screen: {ex.Message}");
        }
        context.Log($"[{Name}] Combined dialog/wait loop finished after {loopStopwatch.ElapsedMilliseconds}ms " +
            $"({loopResult.DismissedTitles.Count} window(s) dismissed, ready={loopResult.AddNewRxReady}).");

        if (!loopResult.AddNewRxReady || addNewRxWindow is null)
        {
            var dump = SafeDumpUiaTree();
            var reason = "F3 was sent, but couldn't find the \"Add New Rx\" screen within " +
                $"{CombinedPreEntryLoopTimeout.TotalSeconds:0}s — no distinctly-titled \"New Rx\" window appeared, and the " +
                "prescriber/NDC fields never showed up on the original window either (failing loud rather than guessing).";
            if (loopResult.DismissedTitles.Count > 0)
            {
                reason += $" Dismissed {loopResult.DismissedTitles.Count} window(s) along the way: {string.Join(", ", loopResult.DismissedTitles)}.";
            }
            var lastSeen = DescribeAnyPioneerWindowForLog();
            reason += lastSeen is not null ? $" Last PioneerRx window seen: {lastSeen}." : " No PioneerRx window was observed at all.";
            reason += dump.Success && dump.FilePath is not null
                ? $" UIA tree dump written to {dump.FilePath} for troubleshooting."
                : $" (Also tried to write a UIA tree dump for troubleshooting: {dump.Message})";
            return new PioneerEntryStepResult(Name, Success: false, DryRun: false, reason);
        }

        context.AttachedWindow = addNewRxWindow;

        var message = "Sent F3 and dismissed any pre-entry dialogs.";
        if (loopResult.DismissedTitles.Count > 0)
        {
            message += $" Also dismissed {loopResult.DismissedTitles.Count} window(s): {string.Join(", ", loopResult.DismissedTitles)}.";
        }
        return new PioneerEntryStepResult(Name, Success: true, DryRun: false, message);
    }

    /// <summary>
    /// V-T28: the "never 'Unexpected error' — surface a friendly stalled
    /// message instead" half of the fix. Called only once a RECOVERABLE
    /// (timeout-shaped) exception has survived AutoWatchRetry's whole
    /// overall budget — i.e. this step has been genuinely stuck on `what`
    /// for AutoWatchRetry.DefaultOverallBudget, not just a one-tick hiccup.
    /// Names the last PioneerRx window actually seen (title/class/automation
    /// id — Will's brief, verbatim) and writes a UIA tree dump the same way
    /// the "couldn't find Add New Rx" branch below already does, so Will has
    /// something concrete to troubleshoot from instead of a bare exception
    /// message.</summary>
    private PioneerEntryStepResult BuildStalledResult(string what, Exception ex)
    {
        var lastSeen = DescribeAnyPioneerWindowForLog();
        var dump = SafeDumpUiaTree();

        var reason = $"Stalled while {what} — PioneerRx kept timing out responding to UI Automation " +
            $"({ex.GetType().Name}: {ex.Message}) for longer than {AutoWatchRetry.DefaultOverallBudget.TotalSeconds:0}s " +
            "(likely busy, or showing a modal this step doesn't poll for).";
        reason += lastSeen is not null ? $" Last PioneerRx window seen: {lastSeen}." : " No PioneerRx window was observed during the wait.";
        reason += dump.Success && dump.FilePath is not null
            ? $" UIA tree dump written to {dump.FilePath} for troubleshooting."
            : $" (Also tried to write a UIA tree dump for troubleshooting: {dump.Message})";

        return new PioneerEntryStepResult(Name, Success: false, DryRun: false, reason);
    }

    /// <summary>Best-effort, NO-PHI snapshot of whichever top-level window
    /// belonging to the PioneerRx process is currently on top — used by
    /// BuildStalledResult and the "couldn't find Add New Rx" branch above so
    /// a stall/failure message can name what was actually visible instead of
    /// just "not found." Title is truncated to the portion before the first
    /// " - " (same convention as PioneerRxAttachment.TryAttach's own
    /// DescribeForLog — never a patient name, which some PioneerRx window
    /// titles carry after that delimiter). Never throws — returns null on
    /// any UIA failure or if no Pioneer window is currently visible at
    /// all.</summary>
    private static string? DescribeAnyPioneerWindowForLog()
    {
        try
        {
            using var automation = new UIA3Automation();
            var desktop = automation.GetDesktop();
            foreach (var window in desktop.FindAllChildren())
            {
                if (!IsPioneerProcessWindow(window)) continue;

                var name = SafeName(window);
                var screenNameOnly = name.Split(new[] { " - " }, 2, StringSplitOptions.None)[0];

                string className;
                try { className = window.ClassName ?? "<null>"; } catch { className = "<unknown>"; }

                string automationId;
                try { automationId = window.AutomationId ?? "<null>"; } catch { automationId = "<unknown>"; }

                return $"\"{screenNameOnly}\" (class '{className}', automationId '{automationId}')";
            }
        }
        catch
        {
            // Best-effort only — see doc comment.
        }
        return null;
    }

    private static int TicksFor(TimeSpan timeout) =>
        (int)Math.Ceiling(timeout.TotalMilliseconds / PollInterval.TotalMilliseconds);

    /// <summary>
    /// V-..., 2026-09-10: PURE polling algorithm (no UIA/FlaUI dependency
    /// of its own — same "pure logic split out as a public static method
    /// for testability" pattern as WaitForAsync below) that replaces the
    /// old DismissPendingDialogsAsync + DismissAllStrayWindowsAsync +
    /// WaitForAsync three-phase sequence — see the class doc comment's
    /// SPEED REWORK section for why. Every tick checks isAddNewRxReady
    /// FIRST and returns immediately the moment it's true; otherwise tries
    /// tryDismissNextPending (which both checks AND dismisses whichever
    /// known dialog or stray window is CURRENTLY showing, in one call — so
    /// a caller never dismisses the same one twice) and, if it dismissed
    /// something, loops back to check readiness again immediately (no
    /// wait — a dismissal may reveal Add New Rx, or the next dialog,
    /// right away). Only waits (via waitTick) after a tick where nothing
    /// was ready AND nothing was dismissed, giving up once maxEmptyTicks
    /// such empty ticks have passed in a row.
    /// </summary>
    public static async Task<CombinedPreEntryLoopResult> RunCombinedPreEntryLoopAsync(
        Func<bool> isAddNewRxReady,
        Func<string?> tryDismissNextPending,
        int maxEmptyTicks,
        Func<Task> waitTick,
        CancellationToken cancellationToken = default)
    {
        var dismissed = new List<string>();
        var emptyTicks = 0;

        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (isAddNewRxReady())
            {
                return new CombinedPreEntryLoopResult(true, dismissed);
            }

            var title = tryDismissNextPending();
            if (title is not null)
            {
                dismissed.Add(title);
                emptyTicks = 0;
                continue;
            }

            if (emptyTicks >= maxEmptyTicks)
            {
                return new CombinedPreEntryLoopResult(false, dismissed);
            }
            emptyTicks++;
            await waitTick();
        }
    }

    /// <summary>
    /// PURE "wait until either of two independent signals finds
    /// something" polling primitive — used by InputLotAndExpirationStep
    /// (V-..., 2026-09-10: "poll for the field for up to 15s instead of
    /// failing after ~1s") to wait for a field to appear, via the
    /// single-signal overload below. Checks tryFindByPrimarySignal first,
    /// then tryFindByFallbackSignal, every tick; returns the first
    /// non-null result from either, or null once maxEmptyTicks empty
    /// ticks have passed. Generic (not AutomationElement-specific) so it's
    /// directly unit-testable with plain string/fake delegates — see
    /// SendF3AndDismissPreEntryDialogsStepTests.cs.
    /// </summary>
    public static async Task<T?> WaitForAsync<T>(
        Func<T?> tryFindByPrimarySignal,
        Func<T?> tryFindByFallbackSignal,
        int maxEmptyTicks,
        Func<Task> waitTick,
        CancellationToken cancellationToken = default)
        where T : class
    {
        var tick = 0;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var found = tryFindByPrimarySignal() ?? tryFindByFallbackSignal();
            if (found is not null) return found;

            if (tick >= maxEmptyTicks) return null;
            tick++;
            await waitTick();
        }
    }

    /// <summary>Convenience overload of WaitForAsync for a caller with
    /// only ONE signal to poll (InputLotAndExpirationStep's "does the lot
    /// field exist yet") — a null-returning fallback makes this identical
    /// in behavior to the two-signal form, just without an awkward
    /// always-null delegate at every call site.</summary>
    public static Task<T?> WaitForAsync<T>(
        Func<T?> tryFind,
        int maxEmptyTicks,
        Func<Task> waitTick,
        CancellationToken cancellationToken = default)
        where T : class =>
        WaitForAsync(tryFind, static () => null, maxEmptyTicks, waitTick, cancellationToken);

    /// <summary>
    /// V-..., 2026-09-10: the combined loop's single "what's in the way
    /// right now" check — tries every known dialog title first (expected,
    /// named — see TryDismissIfShowing), then falls back to ESCing any
    /// OTHER unexpected top-level Pioneer window that appeared after F3
    /// (see TryDismissNextStrayPioneerWindow). Returns the dismissed
    /// window's title, or null if nothing was found to dismiss this
    /// tick.
    /// </summary>
    private static string? TryDismissNextPendingDialogOrStrayWindow(
        AutomationElement attachedWindow, IReadOnlySet<IntPtr> baselineHandles, IntPtr excludeHandle, Dictionary<IntPtr, int> strayAttempts)
    {
        foreach (var title in PreEntryDialogTitles.All)
        {
            if (TryDismissIfShowing(attachedWindow, title)) return title;
        }
        return TryDismissNextStrayPioneerWindow(baselineHandles, excludeHandle, strayAttempts);
    }

    /// <summary>
    /// Scans BOTH top-level windows owned by the Pioneer process AND UIA
    /// descendants of the attached window (ControlType Window/Pane/Custom)
    /// for a title matching `titleSubstring` (via
    /// PreEntryDialogTitles.MatchesWithAliases) — see class doc comment.
    /// </summary>
    private static bool TryDismissIfShowing(AutomationElement attachedWindow, string titleSubstring)
    {
        var topLevel = FindTopLevelPioneerWindowByTitle(name => PreEntryDialogTitles.MatchesWithAliases(name, titleSubstring));
        if (topLevel is not null) return TryDismiss(topLevel);

        var descendant = FindDialogDescendant(attachedWindow, titleSubstring);
        return descendant is not null && TryDismiss(descendant);
    }

    /// <summary>Live scan+ESC for one stray (unrecognized, non-baseline,
    /// non-main) Pioneer top-level window. `attempts` caps retries per
    /// handle (maxAttemptsPerWindow) so a window whose ESC never actually
    /// closes it can't spin this loop forever on the same stubborn window
    /// instead of eventually giving up and letting the step continue.</summary>
    private static string? TryDismissNextStrayPioneerWindow(
        IReadOnlySet<IntPtr> baselineHandles, IntPtr excludeHandle, Dictionary<IntPtr, int> attempts)
    {
        const int maxAttemptsPerWindow = 3;
        try
        {
            using var automation = new UIA3Automation();
            var desktop = automation.GetDesktop();
            foreach (var window in desktop.FindAllChildren())
            {
                if (!IsPioneerProcessWindow(window)) continue;

                var handle = SafeNativeHandle(window);
                if (handle == IntPtr.Zero || handle == excludeHandle) continue;
                if (baselineHandles.Contains(handle)) continue;
                attempts.TryGetValue(handle, out var count);
                if (count >= maxAttemptsPerWindow) continue;

                var title = SafeName(window);
                attempts[handle] = count + 1;
                if (TryDismiss(window)) return title;
            }
        }
        catch
        {
            // Treated as "nothing to dismiss this tick," same posture as
            // every other UIA scan in this file.
        }
        return null;
    }

    /// <summary>Every top-level window currently owned by the Pioneer
    /// process, taken right before F3 is sent — lets the stray-window
    /// check tell "a window that appeared because of F3" apart from
    /// "a window that was already open" (e.g. some other unrelated
    /// PioneerRx screen the pharmacist had open). Best-effort/never
    /// throws — an empty snapshot just means every Pioneer window later
    /// seen is treated as new, which is still safe (ESCing an
    /// already-legitimate window is a no-op if it isn't actually a
    /// dismissible dialog).</summary>
    private static HashSet<IntPtr> SnapshotPioneerWindowHandles()
    {
        var handles = new HashSet<IntPtr>();
        try
        {
            using var automation = new UIA3Automation();
            var desktop = automation.GetDesktop();
            foreach (var window in desktop.FindAllChildren())
            {
                if (!IsPioneerProcessWindow(window)) continue;
                var handle = SafeNativeHandle(window);
                if (handle != IntPtr.Zero) handles.Add(handle);
            }
        }
        catch
        {
            // Best-effort baseline only — see doc comment above.
        }
        return handles;
    }

    /// <summary>Scans top-level desktop windows for one belonging to the
    /// Pioneer process whose title satisfies `titleMatches`, optionally
    /// excluding one handle. Never throws — treated as "not found," same
    /// posture as PioneerRxAttachment.TryAttach.</summary>
    private static AutomationElement? FindTopLevelPioneerWindowByTitle(Func<string, bool> titleMatches, IntPtr excludeHandle = default)
    {
        try
        {
            using var automation = new UIA3Automation();
            var desktop = automation.GetDesktop();
            foreach (var window in desktop.FindAllChildren())
            {
                string? name;
                try { name = window.Name; } catch { continue; }
                if (string.IsNullOrEmpty(name)) continue;
                if (!IsPioneerProcessWindow(window)) continue;

                var handle = SafeNativeHandle(window);
                if (excludeHandle != IntPtr.Zero && handle == excludeHandle) continue;

                if (titleMatches(name)) return window;
            }
        }
        catch
        {
            // Treated as "not found," same posture as PioneerRxAttachment.TryAttach.
        }
        return null;
    }

    /// <summary>MSG893 item 2, part (a): the pre-entry dialogs may be UIA
    /// child Windows/Panes/Custom elements INSIDE the attached window
    /// rather than separate top-level windows — scans for one whose Name
    /// matches `titleSubstring` (via MatchesWithAliases). Never throws —
    /// treated as "not found."</summary>
    private static AutomationElement? FindDialogDescendant(AutomationElement window, string titleSubstring)
    {
        try
        {
            var condition = new OrCondition(new ConditionBase[]
            {
                window.ConditionFactory.ByControlType(ControlType.Window),
                window.ConditionFactory.ByControlType(ControlType.Pane),
                window.ConditionFactory.ByControlType(ControlType.Custom),
            });

            foreach (var descendant in window.FindAllDescendants(condition))
            {
                string? name;
                try { name = descendant.Name; } catch { continue; }
                if (!string.IsNullOrEmpty(name) && PreEntryDialogTitles.MatchesWithAliases(name, titleSubstring))
                {
                    return descendant;
                }
            }
        }
        catch
        {
            // Treated as "not found," same posture as the rest of this file's UIA scans.
        }
        return null;
    }

    /// <summary>MSG893 item 2, part (b): does `window` already expose the
    /// prescriber quick-search or drug/NDC quick-search field — the SAME
    /// AutomationIds SelectPrescriberStep/InputVaccineCodeStep already
    /// search for — meaning this window is (or already looks like) the
    /// "Add New Rx" screen even if its title never changed. Never
    /// throws.</summary>
    private static bool HasNextStepField(AutomationElement window)
    {
        try
        {
            var prescriberField = window.FindFirstDescendant(cf => cf.ByAutomationId(SelectPrescriberStep.PrescriberQuickSearchAutomationId));
            if (prescriberField is not null) return true;

            var ndcField = window.FindFirstDescendant(cf => cf.ByAutomationId(InputVaccineCodeStep.PrescribedItemQuickSearchAutomationId));
            return ndcField is not null;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Wraps a known window handle back into an AutomationElement
    /// (AutomationBase.FromHandle) without a fresh desktop scan — used to
    /// re-check the SAME window (by handle) for HasNextStepField above.
    /// Never throws; returns null for IntPtr.Zero or any UIA failure
    /// (e.g. the window has since closed).</summary>
    private static AutomationElement? TryGetElementFromHandle(IntPtr handle)
    {
        if (handle == IntPtr.Zero) return null;
        try
        {
            using var automation = new UIA3Automation();
            return automation.FromHandle(handle);
        }
        catch
        {
            return null;
        }
    }

    private static bool IsPioneerProcessWindow(AutomationElement window)
    {
        var processName = TryGetProcessName(window);
        return processName is not null &&
            PioneerRxTitles.TargetProcessNames.Any(target => string.Equals(target, processName, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Same pattern as PioneerRxAttachment's own process-name
    /// lookup — reads the owning process's name via the element's UIA
    /// ProcessId, returning null (never throwing) if it can't be read.</summary>
    private static string? TryGetProcessName(AutomationElement window)
    {
        try
        {
            var pid = window.FrameworkAutomationElement.ProcessId;
            if (pid <= 0) return null;
            using var process = Process.GetProcessById(pid);
            return process.ProcessName;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>MSG893 item 2: best-effort UIA tree dump on a final
    /// re-attach failure, reusing UiaTreeDumper (the same "Dump Pioneer
    /// UIA tree" button uses) — see class doc comment, part (b). Never
    /// throws: a failure here is reported via the returned DumpOutcome's
    /// own Message, not an exception.</summary>
    private static UiaTreeDumper.DumpOutcome SafeDumpUiaTree()
    {
        try
        {
            return UiaTreeDumper.DumpAttachedPioneerWindow();
        }
        catch (Exception ex)
        {
            return new UiaTreeDumper.DumpOutcome(false, null, null, $"Dump threw: {ex.Message}");
        }
    }

    private static bool TryDismiss(AutomationElement dialog)
    {
        try
        {
            dialog.FocusNative();
            Keyboard.Type(VirtualKeyShort.ESCAPE);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static string SafeName(AutomationElement element)
    {
        try { return element.Name ?? ""; } catch { return ""; }
    }

    /// <summary>Same pattern as rx-verify's PioneerRxWindow.SafeNativeHandle
    /// — reads the underlying HWND via FlaUI's FrameworkAutomationElement,
    /// returning IntPtr.Zero (never throwing) if it can't be read.</summary>
    private static IntPtr SafeNativeHandle(AutomationElement element)
    {
        try
        {
            return element.FrameworkAutomationElement.NativeWindowHandle ?? IntPtr.Zero;
        }
        catch
        {
            return IntPtr.Zero;
        }
    }
}

/// <summary>Outcome of RunCombinedPreEntryLoopAsync — AddNewRxReady is
/// true only when the loop exited because isAddNewRxReady() returned
/// true (never merely because the loop ran out of ticks); DismissedTitles
/// lists every window (known dialog or stray) dismissed along the way, in
/// the order it happened.</summary>
public readonly record struct CombinedPreEntryLoopResult(bool AddNewRxReady, IReadOnlyList<string> DismissedTitles);
