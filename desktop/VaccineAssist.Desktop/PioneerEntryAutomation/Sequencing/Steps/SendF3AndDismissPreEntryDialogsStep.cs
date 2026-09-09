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
/// NEW step 2 of PlaceholderVaccineEntrySequence (Will's brief, 2026-09-07,
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
/// code recognized) rather than distinctly-titled top-level windows. This
/// rework:
///   (a) Dialog dismissal now scans BOTH top-level windows OWNED BY THE
///       PIONEER PROCESS (not just any desktop window — see
///       FindTopLevelPioneerWindowByTitle) AND UIA descendants of the
///       attached window with ControlType Window/Pane/Custom (see
///       FindDialogDescendant), matching via
///       PreEntryDialogTitles.MatchesWithAliases (also matches "Cycle
///       Fill" alone). It additionally sweeps for ANY top-level Pioneer
///       window that appeared after F3 and isn't the main window,
///       ESCing it even with no recognized title (DismissAllStrayWindowsAsync
///       / TryDismissNextStrayPioneerWindow) — logged so an
///       unrecognized dialog is at least visible in the step log instead
///       of silently stalling the whole sequence.
///   (b) Re-attaching to "Add New Rx" no longer requires a DISTINCT
///       window handle: WaitForAsync below accepts EITHER (i) a
///       top-level Pioneer window whose title contains "New Rx" (same as
///       before, excluding the pre-F3 window) OR (ii) the SAME window
///       (by handle) now exposing the prescriber/NDC quick-search field
///       the very next two steps already search for (reusing their exact
///       AutomationIds — see HasNextStepField) — matching this being a
///       single-window app where the title may never actually change.
///       Only fails if NEITHER shows up inside AddNewRxWaitTimeout, and a
///       failure now automatically writes a UIA tree dump (reusing
///       UiaTreeDumper — the same "Dump Pioneer UIA tree" button uses)
///       and includes its path in the failure message.
///   Combined dialog-dismissal timeout raised from 8s to 12s
///   (CombinedDialogsTimeout) per Will's brief; the two new phases (stray
///   window sweep, Add-New-Rx wait) each get their OWN separate, smaller
///   budget (StrayWindowSweepTimeout / AddNewRxWaitTimeout) rather than
///   sharing/extending that one number — Will's brief only specified the
///   known-dialog number, so this keeps every phase independently
///   bounded and logged rather than guessing how to split a single
///   number three ways.
///
/// SEQUENCE: (1) send F3 to the attached window; (2) run
/// DismissPendingDialogsAsync against a SINGLE SHARED tick budget
/// (CombinedDialogsTimeout / PollInterval) to ESC whichever of
/// "Priority"/"Scan Hard Copy"/"Patient on Cycle Fill" shows up, in
/// whatever order, rescanning immediately after each dismissal; (2b)
/// sweep for any other unexpected Pioneer window and ESC it too; (3)
/// wait for and re-attach to the "Add New Rx" screen per (b) above and
/// overwrite context.AttachedWindow with it.
///
/// REVIEWER FIX (request-changes round, 2026-09-07) — dialog polling: the
/// original version ran two INDEPENDENT waits, each with its own
/// per-dialog timeout, checking "Priority" to completion before ever
/// checking "Scan Hard Copy" at all. Fixed by DismissPendingDialogsAsync
/// below: a SINGLE shared budget, scanning for ANY pending title on every
/// tick and removing each the moment it's dismissed, rescanning
/// IMMEDIATELY (no wait) right after a dismissal — order-agnostic, and
/// correct for the sequential-appearance case too. Extracted as its own
/// PUBLIC static method (this repo has no InternalsVisibleTo wired up —
/// same "pure logic split out as a public static method for testability"
/// pattern as Uia/UiaTreeDumper.TruncateValue and
/// Uia/PioneerRxPresenceDecision) so xUnit can drive it with fake
/// tryDismissIfShowing/waitTick delegates instead of real UIA/wall-clock
/// waits — see SendF3AndDismissPreEntryDialogsStepTests.cs. UNCHANGED by
/// the MSG893 item 2 rework above — only the live delegate passed into it
/// (TryDismissIfShowing) changed what it scans.
///
/// TIME-BOXED, NOT BLOCKING: Will's brief explicitly allows for these
/// dialogs to be "configured off on some machines" — on a shared-budget
/// timeout with dialogs still pending, this step logs a warning and moves
/// on rather than failing the whole entry or hanging indefinitely.
///
/// NOT CONFIRMED against a live UIA dump — see PreEntryDialogTitles.cs's
/// own doc comment for exactly what's unconfirmed and why. This step's
/// pure decision logic (dry-run description, guard clauses, title
/// matching, the DismissPendingDialogsAsync polling algorithm, and the
/// new WaitForAsync/DismissAllStrayWindowsAsync polling primitives) is
/// covered by SendF3AndDismissPreEntryDialogsStepTests.cs; the live
/// FlaUI/UIA calls below (like every other step's live branch in this
/// sequence) can only be proven against a real Pioneer install on
/// Windows.
/// </summary>
public sealed class SendF3AndDismissPreEntryDialogsStep : IPioneerEntryStep
{
    /// <summary>Shared budget for the KNOWN dialogs (Priority/Scan Hard
    /// Copy/Patient on Cycle Fill) combined, not per-dialog — see the
    /// REVIEWER FIX note above. Raised from 8s to 12s (MSG893 item 2,
    /// Will's brief, verbatim). Converted to a tick count (via
    /// PollInterval) for DismissPendingDialogsAsync, which is
    /// deadline-agnostic/pure — it counts consecutive empty ticks rather
    /// than reading the wall clock, so it's drivable by a test with no
    /// real waiting at all.</summary>
    public static readonly TimeSpan CombinedDialogsTimeout = TimeSpan.FromSeconds(12);

    /// <summary>MSG893 item 2: separate, smaller budget for the
    /// "ESC any OTHER unexpected Pioneer window" sweep that runs after the
    /// known-dialog loop above — see DismissAllStrayWindowsAsync. Kept
    /// short and independent so a machine with no such extra window pays
    /// only a couple of quick empty scans, never a share of the 12s
    /// budget above.</summary>
    private static readonly TimeSpan StrayWindowSweepTimeout = TimeSpan.FromSeconds(3);

    /// <summary>MSG893 item 2: separate budget for waiting on the
    /// Add-New-Rx screen to appear (by title OR by its fields showing up
    /// on the original window) once the dialogs above are clear — see
    /// WaitForAsync.</summary>
    private static readonly TimeSpan AddNewRxWaitTimeout = TimeSpan.FromSeconds(5);

    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(200);

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
                    context.Log($"[{Name}] Still waiting to send F3 to the Rx Profile window after " +
                        $"{elapsed.TotalSeconds:0.0}s — {ex.GetType().Name}: {ex.Message}. PioneerRx may be busy; retrying...");
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

        IReadOnlySet<string> pending;
        try
        {
            pending = await DismissPendingDialogsAsync(
                PreEntryDialogTitles.All,
                TicksFor(CombinedDialogsTimeout),
                titleSubstring => TryDismissIfShowing(attachedWindow, titleSubstring),
                WaitTick,
                cancellationToken);
        }
        catch (Exception ex)
        {
            return AutoWatchErrorClassifier.IsRecoverable(ex)
                ? BuildStalledResult("dismissing pre-entry dialogs (Priority / Scan Hard Copy / Patient on Cycle Fill)", ex)
                : new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                    $"Error while dismissing pre-entry dialogs: {ex.Message}");
        }

        var warnings = new List<string>();
        if (pending.Count > 0)
        {
            var pendingList = string.Join(", ", pending.Select(t => $"\"{t}\""));
            warnings.Add(
                $"{pendingList} dialog(s) did not appear/dismiss within {CombinedDialogsTimeout.TotalSeconds:0}s — " +
                "continuing (may be configured off on this machine, or its title doesn't match PreEntryDialogTitles yet).");
        }

        // MSG893 item 2: PioneerRx can also throw up a modal we don't have
        // a known title for at all — rather than hang or silently continue
        // past it, ESC any OTHER top-level window that belongs to the
        // Pioneer process, wasn't open before F3, and isn't the main
        // window itself.
        var strayAttempts = new Dictionary<IntPtr, int>();
        IReadOnlyList<string> strayDismissed;
        try
        {
            strayDismissed = await DismissAllStrayWindowsAsync(
                () => TryDismissNextStrayPioneerWindow(baselineHandles, previousHandle, strayAttempts),
                TicksFor(StrayWindowSweepTimeout),
                WaitTick,
                cancellationToken);
        }
        catch (Exception ex)
        {
            return AutoWatchErrorClassifier.IsRecoverable(ex)
                ? BuildStalledResult("checking for unexpected PioneerRx windows", ex)
                : new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                    $"Error while checking for unexpected PioneerRx windows: {ex.Message}");
        }
        foreach (var title in strayDismissed)
        {
            context.Log($"[{Name}] Dismissed an unexpected PioneerRx window (\"{title}\") that appeared after F3.");
        }

        // Re-attach: MSG893 item 2 rework — no longer requires a
        // DISTINCTLY titled window (see class doc comment, part (b)).
        AutomationElement? addNewRxWindow;
        try
        {
            addNewRxWindow = await WaitForAsync<AutomationElement>(
                () => FindTopLevelPioneerWindowByTitle(name => name.Contains("New Rx", StringComparison.OrdinalIgnoreCase), previousHandle),
                () =>
                {
                    var current = TryGetElementFromHandle(previousHandle);
                    return current is not null && HasNextStepField(current) ? current : null;
                },
                TicksFor(AddNewRxWaitTimeout),
                WaitTick,
                cancellationToken);
        }
        catch (Exception ex)
        {
            return AutoWatchErrorClassifier.IsRecoverable(ex)
                ? BuildStalledResult("re-attaching to the resulting \"Add New Rx\" window", ex)
                : new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                    $"F3 was sent, but re-attaching to the resulting \"Add New Rx\" window failed: {ex.Message}");
        }

        if (addNewRxWindow is null)
        {
            var dump = SafeDumpUiaTree();
            var reason = "F3 was sent, but couldn't find the \"Add New Rx\" screen — no distinctly-titled " +
                "\"New Rx\" window appeared, and the prescriber/NDC fields never showed up on the original " +
                "window either (failing loud rather than guessing).";
            var lastSeen = DescribeAnyPioneerWindowForLog();
            reason += lastSeen is not null ? $" Last PioneerRx window seen: {lastSeen}." : " No PioneerRx window was observed at all.";
            reason += dump.Success && dump.FilePath is not null
                ? $" UIA tree dump written to {dump.FilePath} for troubleshooting."
                : $" (Also tried to write a UIA tree dump for troubleshooting: {dump.Message})";
            if (warnings.Count > 0) reason += " " + string.Join(" ", warnings);
            return new PioneerEntryStepResult(Name, Success: false, DryRun: false, reason);
        }

        context.AttachedWindow = addNewRxWindow;

        var message = "Sent F3 and dismissed any pre-entry dialogs.";
        if (strayDismissed.Count > 0)
        {
            message += $" Also dismissed {strayDismissed.Count} unexpected window(s): {string.Join(", ", strayDismissed)}.";
        }
        if (warnings.Count > 0)
        {
            message += " " + string.Join(" ", warnings);
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
    /// PURE polling algorithm (no UIA/FlaUI dependency of its own — see
    /// this class's own REVIEWER FIX note). Repeatedly scans `titles` for
    /// whichever is CURRENTLY showing (via tryDismissIfShowing, which both
    /// checks AND dismisses in one call — so a caller never dismisses the
    /// same one twice) and removes each as it's dismissed, immediately
    /// trying again with no wait (a dismissal may reveal the next dialog
    /// right away — the sequential/modal case this whole rewrite exists
    /// for). Only waits (via waitTick) after a tick where NOTHING was
    /// dismissed, and gives up once maxEmptyTicks such empty ticks have
    /// passed in a row. Returns whatever's LEFT in the pending set (empty =
    /// everything got dismissed) — the caller turns a non-empty result
    /// into a warning, never a hard failure (Will's brief: dialogs may be
    /// "configured off on some machines").
    /// </summary>
    public static async Task<IReadOnlySet<string>> DismissPendingDialogsAsync(
        IEnumerable<string> titles,
        int maxEmptyTicks,
        Func<string, bool> tryDismissIfShowing,
        Func<Task> waitTick,
        CancellationToken cancellationToken = default)
    {
        var pending = new HashSet<string>(titles, StringComparer.OrdinalIgnoreCase);
        var emptyTicks = 0;

        while (pending.Count > 0 && emptyTicks <= maxEmptyTicks)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var dismissed = pending.FirstOrDefault(tryDismissIfShowing);
            if (dismissed is not null)
            {
                pending.Remove(dismissed);
                emptyTicks = 0;
                continue; // rescan immediately — dismissing one may reveal the next right away
            }

            emptyTicks++;
            await waitTick();
        }

        return pending;
    }

    /// <summary>
    /// MSG893 item 2: PURE polling primitive for "keep ESCing whatever
    /// unexpected window shows up until nothing new appears for a while."
    /// tryDismissNextStray does the live scan+ESC and returns the
    /// dismissed window's title, or null if nothing was found this tick —
    /// same "one delegate call does find-and-dismiss together" shape as
    /// DismissPendingDialogsAsync's tryDismissIfShowing, and testable the
    /// same way (fake delegate, no real UIA/wall-clock wait).
    /// </summary>
    public static async Task<IReadOnlyList<string>> DismissAllStrayWindowsAsync(
        Func<string?> tryDismissNextStray,
        int maxEmptyTicks,
        Func<Task> waitTick,
        CancellationToken cancellationToken = default)
    {
        var dismissed = new List<string>();
        var emptyTicks = 0;

        while (emptyTicks <= maxEmptyTicks)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var title = tryDismissNextStray();
            if (title is not null)
            {
                dismissed.Add(title);
                emptyTicks = 0;
                continue;
            }

            emptyTicks++;
            await waitTick();
        }

        return dismissed;
    }

    /// <summary>
    /// MSG893 item 2: PURE polling primitive for "wait until EITHER of two
    /// independent signals finds something" — used for the Add-New-Rx
    /// re-attach (title match OR field match; see class doc comment, part
    /// (b)). Checks tryFindByPrimarySignal first, then
    /// tryFindByFallbackSignal, every tick; returns the first non-null
    /// result from either, or null once maxEmptyTicks empty ticks have
    /// passed. Generic (not AutomationElement-specific) so it's directly
    /// unit-testable with plain string/fake delegates — see
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

    /// <summary>
    /// MSG893 item 2: scans BOTH top-level windows owned by the Pioneer
    /// process AND UIA descendants of the attached window (ControlType
    /// Window/Pane/Custom) for a title matching `titleSubstring` (via
    /// PreEntryDialogTitles.MatchesWithAliases) — see class doc comment,
    /// part (a).
    /// </summary>
    private static bool TryDismissIfShowing(AutomationElement attachedWindow, string titleSubstring)
    {
        var topLevel = FindTopLevelPioneerWindowByTitle(name => PreEntryDialogTitles.MatchesWithAliases(name, titleSubstring));
        if (topLevel is not null) return TryDismiss(topLevel);

        var descendant = FindDialogDescendant(attachedWindow, titleSubstring);
        return descendant is not null && TryDismiss(descendant);
    }

    /// <summary>MSG893 item 2: live scan+ESC for one stray (unrecognized,
    /// non-baseline, non-main) Pioneer top-level window — see
    /// DismissAllStrayWindowsAsync. `attempts` caps retries per handle
    /// (maxAttemptsPerWindow) so a window whose ESC never actually closes
    /// it can't spin this loop forever on the same stubborn window
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
    /// sweep tell "a window that appeared because of F3" apart from
    /// "a window that was already open" (e.g. some other unrelated
    /// PioneerRx screen the pharmacist had open). Best-effort/never
    /// throws — an empty snapshot just means the stray sweep treats every
    /// Pioneer window it later sees as new, which is still safe (ESCing
    /// an already-legitimate window is a no-op if it isn't actually a
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
