using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text;
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
///
/// PRIORITY POPUP FIX (V-..., 2026-09-13 — Will, verbatim): "It's getting
/// stuck because it's missing the 'Priority' popup that comes up before
/// data entry can begin. It needs to set the priority to Vaccine when
/// that window comes up. All of this should've been in the original
/// macro file I sent you." Recon for that macro file (and any live UIA
/// dump of this dialog) found neither anywhere in this repo — every other
/// reference to vaccine-add-new.mxe (VaccineEntryPayload.cs lines 32-36,
/// AdminSite.cs lines 49-66, this folder's TODO.md lines 79-80/298-337/
/// 322-325) quotes OTHER sections of it (clipboard payload format, the
/// admin-site letter code, the final Add New Rx keystroke sequence, the
/// Medicare home-visit prompt), and PreEntryDialogTitles.cs's own doc
/// comment already flagged Priority/Scan Hard Copy/Patient on Cycle Fill
/// as dialogs no live dump exists for. So Priority's real control shape
/// (ComboBox vs. ListBox vs. DataGrid) is still unconfirmed — but "ESC
/// past it" was simply wrong (it must be SET, not dismissed), so this
/// round changes Priority's handling from ESC to select-and-confirm:
/// TryHandlePriorityIfShowing looks for a ComboBox first (expand + select
/// the item whose Name contains PriorityValue), then any other selectable
/// ListItem/DataItem anywhere in the dialog, and only if neither can be
/// found falls back to focusing the dialog and typing the value + Enter —
/// "same as the original macro" per Will's own framing, since a macro
/// script would have driven this the same blind-keystroke way. Whichever
/// path runs, TryConfirmDialog then looks for an OK/Confirm button
/// (Invoke pattern) before falling back to a plain Enter keypress.
/// Scan Hard Copy and Patient on Cycle Fill are UNCHANGED (still ESC'd).
/// Every sub-step logs via context.Log (throttled to attempt 1 and every
/// 5th retry after that, AutoWatchRetry.ShouldLogRetry — same throttle
/// QuickSearchFieldEntry already uses for its own "still waiting" spam
/// fix) so a miss is diagnosable from app.log: which UIA shape was tried,
/// which item Names were actually seen, and whether the fallback typed
/// path ran instead.
///
/// STILL STUCK FIX (V-T41, Will, 2026-09-13 night, verbatim): "the app is
/// still getting stuck on the pre-data entry popup windows." That night's
/// app.log showed the combined loop below finish with "0 window(s)
/// dismissed, ready=True," then SelectPrescriberStep burn its whole
/// 40+s retry budget on ElementNotEnabledException — i.e. IsAddNewRxReady
/// declared victory while the prescriber field was still present-but-
/// disabled (and/or some window this repo didn't recognize was still
/// covering the screen). Two fixes:
///   1. HasNextStepField now ALSO requires the field to be ENABLED, not
///      merely present in the UIA tree — a disabled field no longer looks
///      "ready" (see IsEnabledSafe).
///   2. IsAddNewRxReady additionally refuses to report ready while any
///      OTHER enabled top-level Pioneer window (besides the main/attached
///      window and whichever window it just found as the Add New Rx
///      candidate) is showing — see HasBlockingPioneerWindow. That keeps
///      the loop in its dismiss-and-recheck cycle instead of handing
///      control to the next step with a modal still up.
///
/// AUTO-SUGGEST DROPDOWN TIMEOUT FIX (V-T41, Will's run tonight, 2026-09-13
/// 18:53): app.log showed this step time out (0x80131505) after repeatedly
/// finding a Pioneer-owned top-level window with an empty title and window
/// class 'Auto-Suggest Dropdown' (Pioneer's own autocomplete popup for an
/// Add New Rx form field), treating it as an unrecognized pre-entry dialog,
/// and ESCing it every ~7s — which likely cancelled the underlying
/// field/form each time, so the popup (or the loop) kept coming back until
/// the budget ran out. DialogClassifier.IsTransientWindow (pure, tested in
/// DialogClassifierTests.cs) now recognizes transient popup window classes
/// (autocomplete dropdowns, tooltips, and similarly-shaped untitled
/// non-dialog-frame windows) BEFORE any ESC/classification decision is
/// made — TryDismissNextStrayPioneerWindow skips them entirely (never ESCs,
/// logs "ignoring transient window class X" once per handle) and
/// HasBlockingPioneerWindow also ignores them so a still-open autocomplete
/// popup can never block readiness once it's no longer being ESC'd. Real
/// pre-entry dialogs (Priority, Scan Hard Copy, Patient on Cycle Fill) are
/// unaffected — they always carry a title and never match a transient
/// window class.
///
/// Also: TryDismissNextStrayPioneerWindow (an UNRECOGNIZED top-level
/// window — matched no known dialog title) now classifies it by title
/// AND visible button/text content before ESCing blind — "contains
/// Priority" runs the same select-and-confirm handling as a normally
/// recognized Priority dialog, "contains Scan and Hard Copy" dismisses
/// the same way ScanHardCopy always has, otherwise it logs the
/// unrecognized window (title/class/controls) and ESCs once, same as
/// before. And: whenever the combined loop below finishes having
/// dismissed ZERO windows (the exact shape of the V-T41 log line above,
/// including a "ready=True" finish), a full PioneerWindowInventory.Describe()
/// is logged once so the NEXT stall names every window actually on screen.
/// </summary>
public sealed class SendF3AndDismissPreEntryDialogsStep : IPioneerEntryStep
{
    /// <summary>The value selected in the "Priority" dialog — see the
    /// class doc comment's PRIORITY POPUP FIX section. Defaults to
    /// "Vaccine" (Settings.AppSettings.PriorityValue's own default) so a
    /// caller that doesn't thread the setting through (e.g. every existing
    /// test that uses the parameterless constructor) still gets the
    /// behavior Will asked for.</summary>
    private readonly string _priorityValue;

    public SendF3AndDismissPreEntryDialogsStep(string priorityValue = "Vaccine")
    {
        _priorityValue = string.IsNullOrWhiteSpace(priorityValue) ? "Vaccine" : priorityValue;
    }

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
            // stale in this description again. Priority is called out
            // separately (select, not ESC) since the 2026-09-13 fix.
            var otherDialogs = string.Join(", ",
                PreEntryDialogTitles.All.Where(t => t != PreEntryDialogTitles.Priority).Select(t => $"\"{t}\""));
            return new PioneerEntryStepResult(Name, Success: true, DryRun: true,
                $"Would press F3 from the Rx Profile, then select \"{_priorityValue}\" in the \"{PreEntryDialogTitles.Priority}\" " +
                $"dialog (or type \"{_priorityValue}\" + Enter if no selectable list is found) if it appears, and ESC through " +
                $"the {otherDialogs} dialog(s) if any appear (no PioneerRx call made).");
        }

        if (context.AttachedWindow is null)
        {
            return new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                "No PioneerRx window attached — FocusPioneerWindowStep must run (and succeed) before this step.");
        }

        var attachedWindow = context.AttachedWindow;
        var previousHandle = SafeNativeHandle(attachedWindow);
        var baselineHandles = SnapshotPioneerWindowHandles();
        // V-... 2026-09-14 (popup-detection fix — see class doc comment's
        // TOP-LEVEL WINDOW DETECTION FIX section): every dialog-candidate
        // scan below is scoped to THIS SAME PioneerRx process (not merely
        // "any process named PioneerPharmacy/PioneerRx" — see
        // PioneerDialogCandidates.Select) so a stray second Pioneer
        // instance never gets treated as a dialog for THIS attached
        // window.
        var mainProcessId = TryGetProcessId(attachedWindow);

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
        var loggedTransientHandles = new HashSet<IntPtr>();
        var priorityAttempt = 0;
        AutomationElement? addNewRxWindow = null;

        bool IsAddNewRxReady()
        {
            var found = FindTopLevelPioneerWindowByTitle(name => name.Contains("New Rx", StringComparison.OrdinalIgnoreCase), previousHandle, mainProcessId);
            if (found is null)
            {
                var current = TryGetElementFromHandle(previousHandle);
                if (current is not null && HasNextStepField(current)) found = current;
            }
            if (found is null) return false;

            // V-T41: don't declare ready while some OTHER enabled
            // top-level Pioneer window (a modal this step doesn't
            // recognize, or Add New Rx still rendering behind one) is
            // showing — see class doc comment's STILL STUCK FIX section.
            // baselineHandles is excluded too (same as
            // TryDismissNextStrayPioneerWindow's own exclusion) — a window
            // the pharmacist already had open before F3 (e.g. a second
            // Rx Profile on another workflow) is legitimate, not a
            // blocking modal, and this step should never touch it.
            if (HasBlockingPioneerWindow(previousHandle, SafeNativeHandle(found), baselineHandles, mainProcessId))
            {
                return false;
            }

            addNewRxWindow = found;
            return true;
        }

        string? TryDismissNext() =>
            TryDismissNextPendingDialogOrStrayWindow(attachedWindow, baselineHandles, previousHandle, mainProcessId, strayAttempts, loggedTransientHandles, ref priorityAttempt, context.Log);

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

        // V-T41: this is the exact shape of the night's stuck log line
        // ("0 window(s) dismissed, ready=True" followed by 40+s of
        // ElementNotEnabledException on the very next step) — log a full
        // window inventory here, once, regardless of whether this run
        // declared ready or not, so the NEXT stall names every PioneerRx
        // window actually on screen instead of just "still waiting."
        if (loopResult.DismissedTitles.Count == 0)
        {
            context.Log($"[{Name}] 0 windows dismissed by the combined loop — PioneerRx window inventory: {PioneerWindowInventory.Describe()}");
        }

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
    ///
    /// PRIORITY POPUP FIX (2026-09-13): "Priority" is checked FIRST, via
    /// TryHandlePriorityIfShowing (select-and-confirm), and skipped in the
    /// plain ESC-dismiss loop below — Scan Hard Copy and Patient on Cycle
    /// Fill are unchanged. See class doc comment.
    /// </summary>
    private string? TryDismissNextPendingDialogOrStrayWindow(
        AutomationElement attachedWindow, IReadOnlySet<IntPtr> baselineHandles, IntPtr mainHandle, int mainProcessId,
        Dictionary<IntPtr, int> strayAttempts, HashSet<IntPtr> loggedTransientHandles, ref int priorityAttempt, Action<string> log)
    {
        if (TryHandlePriorityIfShowing(attachedWindow, mainHandle, mainProcessId, ref priorityAttempt, log))
        {
            return PreEntryDialogTitles.Priority;
        }

        foreach (var title in PreEntryDialogTitles.All)
        {
            if (title == PreEntryDialogTitles.Priority) continue; // handled above — select+confirm, not ESC
            if (TryDismissIfShowing(attachedWindow, title, mainHandle, mainProcessId)) return title;
        }
        return TryDismissNextStrayPioneerWindow(baselineHandles, mainHandle, mainProcessId, strayAttempts, loggedTransientHandles, ref priorityAttempt, log);
    }

    /// <summary>
    /// Scans BOTH real dialog candidates (see FindPioneerDialogCandidates
    /// — top-level windows of the SAME PioneerRx process, found via the
    /// combined UIA+Win32 enumeration, not just UIA descendants of the
    /// attached window) AND UIA descendants of the attached window
    /// (ControlType Window/Pane/Custom, for the case where a dialog turns
    /// out to be a child pane rather than a separate top-level window) for
    /// a title matching `titleSubstring` (via
    /// PreEntryDialogTitles.MatchesWithAliases) — see class doc comment.
    /// </summary>
    private static bool TryDismissIfShowing(AutomationElement attachedWindow, string titleSubstring, IntPtr mainHandle, int mainProcessId)
    {
        foreach (var (element, info) in FindPioneerDialogCandidates(mainHandle, mainProcessId))
        {
            if (PreEntryDialogTitles.MatchesWithAliases(info.Title, titleSubstring))
            {
                return TryDismiss(element);
            }
        }

        var descendant = FindDialogDescendant(attachedWindow, titleSubstring);
        return descendant is not null && TryDismiss(descendant);
    }

    /// <summary>
    /// V-... 2026-09-14 (popup-detection fix): every top-level window of
    /// the ATTACHED main window's own PioneerRx process (`mainProcessId`),
    /// excluding the main window itself (`mainHandle`) — gathered from
    /// PioneerWindowInventory.EnumerateAllWindows (UIA desktop scan UNION
    /// a raw Win32 EnumWindows/EnumThreadWindows walk — see
    /// Win32WindowEnumerator's own doc comment) and filtered through
    /// PioneerDialogCandidates.Select. THIS is the fix for Will's
    /// verbatim report: "The app is not recognizing the Pioneer windows
    /// that pop up and is instead trying to stay focused and work in the
    /// Pioneer main window" — every dialog lookup in this file
    /// (TryDismissIfShowing, TryHandlePriorityIfShowing,
    /// TryDismissNextStrayPioneerWindow, HasBlockingPioneerWindow) now
    /// scans THIS candidate list instead of a UIA-only desktop walk, so a
    /// Priority/Cycle Fill/Scan Hard Copy dialog that UIA's own walk never
    /// cataloged (but that genuinely exists as a top-level HWND) is still
    /// found. Never throws — a scan failure comes back as an empty list.
    /// </summary>
    private static List<(AutomationElement Element, WindowInfo Info)> FindPioneerDialogCandidates(IntPtr mainHandle, int mainProcessId)
    {
        try
        {
            var all = PioneerWindowInventory.EnumerateAllWindows();
            var candidateInfos = PioneerDialogCandidates.Select(all.Select(pair => pair.Info), mainProcessId, mainHandle);
            var candidateHandles = new HashSet<IntPtr>(candidateInfos.Select(info => info.Handle));
            return all.Where(pair => candidateHandles.Contains(pair.Info.Handle)).ToList();
        }
        catch
        {
            return new List<(AutomationElement, WindowInfo)>();
        }
    }

    /// <summary>
    /// PRIORITY POPUP FIX (see class doc comment) — finds the "Priority"
    /// dialog the same way TryDismissIfShowing finds every other pre-entry
    /// dialog (top-level Pioneer window first, then a UIA descendant of
    /// the attached window), but instead of ESCing it, selects
    /// `_priorityValue` and confirms. Returns false (no dialog found —
    /// caller moves on to the plain ESC-dismiss titles) or true (dialog
    /// found and an attempt was made — success or failure of that attempt
    /// is only reflected in the log, same "found it, attempted the
    /// action" posture as TryDismissIfShowing's own callers use for the
    /// other dialogs). `attempt` is a per-ExecuteAsync-call counter
    /// (declared in ExecuteAsync, threaded by ref through
    /// TryDismissNextPendingDialogOrStrayWindow) used only to throttle
    /// logging via AutoWatchRetry.ShouldLogRetry — the dialog itself is
    /// re-scanned fresh every tick regardless of whether this tick logs.
    /// </summary>
    private bool TryHandlePriorityIfShowing(AutomationElement attachedWindow, IntPtr mainHandle, int mainProcessId, ref int attempt, Action<string> log)
    {
        AutomationElement? dialog = null;
        foreach (var (element, info) in FindPioneerDialogCandidates(mainHandle, mainProcessId))
        {
            if (PreEntryDialogTitles.MatchesWithAliases(info.Title, PreEntryDialogTitles.Priority))
            {
                dialog = element;
                break;
            }
        }
        dialog ??= FindDialogDescendant(attachedWindow, PreEntryDialogTitles.Priority);
        if (dialog is null) return false;

        attempt++;
        HandlePriorityDialog(dialog, attempt, AutoWatchRetry.ShouldLogRetry(attempt), log);
        return true;
    }

    /// <summary>
    /// V-T41: the ACTION half of TryHandlePriorityIfShowing (select
    /// `_priorityValue`, confirm, or fall back to typing it), split out so
    /// it can also be called from TryDismissNextStrayPioneerWindow below
    /// for an UNRECOGNIZED top-level window whose title/visible text
    /// merely CONTAINS "Priority" (Will's broadened brief: "any
    /// dialog/window whose title or visible text contains 'Priority'" —
    /// not just an exact/aliased title match against the known constant).
    /// `attempt` is only used for the "(attempt N)" log wording; `announce`
    /// is the caller's own already-computed AutoWatchRetry.ShouldLogRetry
    /// throttle decision (both callers share ONE attempt counter, threaded
    /// by ref through TryDismissNextPendingDialogOrStrayWindow, so the
    /// throttle behaves the same regardless of which path found the
    /// dialog).
    /// </summary>
    private void HandlePriorityDialog(AutomationElement dialog, int attempt, bool announce, Action<string> log)
    {
        if (announce)
        {
            log($"[{Name}] \"Priority\" dialog: selecting \"{_priorityValue}\" — starting (attempt {attempt})...");
        }

        if (TrySelectPriorityValue(dialog, announce, log, out var howSelected))
        {
            if (announce) log($"[{Name}] \"Priority\" dialog: OK — selected \"{_priorityValue}\" via {howSelected}.");

            if (TryConfirmDialog(dialog))
            {
                if (announce) log($"[{Name}] \"Priority\" dialog: OK — confirmed (OK/Confirm button or Enter).");
            }
            else if (announce)
            {
                log($"[{Name}] \"Priority\" dialog: FAILED to confirm the selection via an OK button or Enter key.");
            }
            return;
        }

        if (announce)
        {
            log($"[{Name}] \"Priority\" dialog: FAILED to find a selectable \"{_priorityValue}\" item via UIA " +
                "(no matching ComboBox/ListBox/DataGrid item) — falling back to typing " +
                $"\"{_priorityValue}\" + Enter, same as the original macro.");
        }

        var typed = TryTypeFallback(dialog, _priorityValue);
        if (announce)
        {
            log(typed
                ? $"[{Name}] \"Priority\" dialog: OK — typed \"{_priorityValue}\" and pressed Enter (fallback)."
                : $"[{Name}] \"Priority\" dialog: FAILED — the typing fallback threw; the dialog may still be showing.");
        }
    }

    /// <summary>
    /// Tries, in the order PioneerRx's confirmed "Add New Rx" dumps suggest
    /// is most likely for a value picker: (1) a ComboBox — expand it (best
    /// effort; some combo boxes list items without needing an explicit
    /// expand), then select whichever child item's Name contains
    /// `_priorityValue` (PriorityValueMatcher.Matches); (2) any other
    /// selectable ListItem/DataItem anywhere else in the dialog (covers a
    /// plain ListBox or a DataGrid row) whose Name matches. `howSelected`
    /// names which shape actually worked, for the caller's OK log line.
    /// Every item Name actually seen is logged (when `announce`) so a miss
    /// is diagnosable from app.log even without a live UIA dump to compare
    /// against. Never throws — any UIA exception is treated as "not
    /// found," same posture as every other scan in this file.
    /// </summary>
    private bool TrySelectPriorityValue(AutomationElement dialog, bool announce, Action<string> log, out string howSelected)
    {
        howSelected = "";
        try
        {
            var comboCondition = dialog.ConditionFactory.ByControlType(ControlType.ComboBox);
            foreach (var combo in dialog.FindAllDescendants(comboCondition))
            {
                try
                {
                    if (combo.Patterns.ExpandCollapse.IsSupported)
                    {
                        combo.Patterns.ExpandCollapse.Pattern.Expand();
                    }
                }
                catch
                {
                    // Best-effort — see doc comment above.
                }

                var seen = new List<string>();
                var item = FindMatchingSelectableItem(combo, _priorityValue, seen);
                if (item is not null && TrySelectItem(item))
                {
                    howSelected = "ComboBox";
                    return true;
                }
                if (announce && seen.Count > 0)
                {
                    log($"[{Name}] \"Priority\" dialog: ComboBox item(s) seen: {string.Join(", ", seen)}.");
                }
            }

            var seenTopLevel = new List<string>();
            var listOrGridItem = FindMatchingSelectableItem(dialog, _priorityValue, seenTopLevel);
            if (listOrGridItem is not null && TrySelectItem(listOrGridItem))
            {
                howSelected = "ListBox/DataGrid";
                return true;
            }
            if (announce && seenTopLevel.Count > 0)
            {
                log($"[{Name}] \"Priority\" dialog: list/grid item(s) seen: {string.Join(", ", seenTopLevel)}.");
            }
        }
        catch (Exception ex)
        {
            if (announce) log($"[{Name}] \"Priority\" dialog: error while scanning for a selectable item: {ex.Message}");
        }
        return false;
    }

    /// <summary>Scans `root`'s ListItem/DataItem descendants (ComboBox
    /// items and ListBox/DataGrid rows are both exposed this way in UIA)
    /// for one whose Name matches `priorityValue`
    /// (PriorityValueMatcher.Matches), recording every Name actually seen
    /// into `seenNames` for the caller's diagnostic log. Never throws.</summary>
    private static AutomationElement? FindMatchingSelectableItem(AutomationElement root, string priorityValue, List<string> seenNames)
    {
        try
        {
            var condition = new OrCondition(new ConditionBase[]
            {
                root.ConditionFactory.ByControlType(ControlType.ListItem),
                root.ConditionFactory.ByControlType(ControlType.DataItem),
            });

            foreach (var candidate in root.FindAllDescendants(condition))
            {
                var name = SafeName(candidate);
                if (!string.IsNullOrEmpty(name)) seenNames.Add(name);
                if (PriorityValueMatcher.Matches(name, priorityValue)) return candidate;
            }
        }
        catch
        {
            // Treated as "not found," same posture as the rest of this file's UIA scans.
        }
        return null;
    }

    /// <summary>Selects `item` via the UIA SelectionItem pattern (the
    /// normal way to pick a ComboBox/ListBox/DataGrid entry); falls back
    /// to Invoke for a legacy control that only exposes that. Never
    /// throws.</summary>
    private static bool TrySelectItem(AutomationElement item)
    {
        try
        {
            if (item.Patterns.SelectionItem.IsSupported)
            {
                item.Patterns.SelectionItem.Pattern.Select();
                return true;
            }
            if (item.Patterns.Invoke.IsSupported)
            {
                item.Patterns.Invoke.Pattern.Invoke();
                return true;
            }
        }
        catch
        {
            // Treated as "couldn't select this candidate" — caller falls back to typing.
        }
        return false;
    }

    /// <summary>Looks for an explicit OK/Confirm button in the dialog
    /// first (UIA Invoke pattern, falling back to FocusNative + Enter if a
    /// matching button isn't invokable); falls back to sending a plain
    /// ENTER to the dialog itself — the same generic "confirm whatever's
    /// focused" action every other field-typing step in this sequence
    /// already relies on (see QuickSearchFieldEntry). Never throws.</summary>
    private static bool TryConfirmDialog(AutomationElement dialog)
    {
        try
        {
            var buttonCondition = dialog.ConditionFactory.ByControlType(ControlType.Button);
            foreach (var button in dialog.FindAllDescendants(buttonCondition))
            {
                var name = SafeName(button);
                if (!name.Contains("OK", StringComparison.OrdinalIgnoreCase) &&
                    !name.Contains("Confirm", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (button.Patterns.Invoke.IsSupported)
                {
                    button.Patterns.Invoke.Pattern.Invoke();
                    return true;
                }
                button.FocusNative();
                Keyboard.Type(VirtualKeyShort.RETURN);
                return true;
            }
        }
        catch
        {
            // Fall through to the plain Enter fallback below.
        }

        try
        {
            dialog.FocusNative();
            Keyboard.Type(VirtualKeyShort.RETURN);
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Last-resort fallback when no selectable UIA control could
    /// be found/selected in the Priority dialog — types the value as
    /// plain keystrokes and presses ENTER, the way a Macro Express script
    /// (Will: "all of this is in the original macro I gave you") would
    /// have driven this same dialog. Never throws.</summary>
    private static bool TryTypeFallback(AutomationElement dialog, string priorityValue)
    {
        try
        {
            dialog.FocusNative();
            Keyboard.Type(priorityValue);
            Keyboard.Type(VirtualKeyShort.RETURN);
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Live scan+classify for one stray (unrecognized, non-baseline,
    /// non-main) Pioneer top-level window. `attempts` caps retries per
    /// handle (maxAttemptsPerWindow) so a window whose ESC never actually
    /// closes it can't spin this loop forever on the same stubborn window
    /// instead of eventually giving up and letting the step continue.
    ///
    /// V-T41 BROADENED MATCH (Will, verbatim): "any dialog/window whose
    /// title or visible text contains 'Priority' -> run the Priority
    /// handler ... contains 'Scan' and 'Hard Copy' -> the existing
    /// dismiss; otherwise log it and press Escape once, then re-check."
    /// Before ESCing an unrecognized window blind (the old behavior),
    /// this now builds its title + first ~10 visible button/text names
    /// (BuildClassificationText) and checks that combined text for
    /// "Priority" (PreEntryDialogTitles.ContainsPriority — handled via
    /// HandlePriorityDialog, the same select-and-confirm logic a normally
    /// recognized Priority dialog gets) or "Scan"+"Hard Copy"
    /// (PreEntryDialogTitles.ContainsScanAndHardCopy — plain ESC, same as
    /// always). Only when NEITHER matches does it fall back to logging the
    /// unrecognized window and ESCing it once, same as before.
    ///
    /// V-... 2026-09-14 (popup-detection fix): the candidate list now comes
    /// from FindPioneerDialogCandidates (combined UIA+Win32 enumeration,
    /// scoped to the attached window's own PioneerRx process — see that
    /// method's doc comment) instead of a bare UIA desktop walk, and
    /// classification uses DialogClassifier.Classify (PatientOnCycleFill —
    /// "Cycle Fill" — is now recognized here too, not just Priority/Scan
    /// Hard Copy, dismissed the same ESC way it always has been via
    /// TryDismissIfShowing's title match).</summary>
    private string? TryDismissNextStrayPioneerWindow(
        IReadOnlySet<IntPtr> baselineHandles, IntPtr mainHandle, int mainProcessId, Dictionary<IntPtr, int> attempts,
        HashSet<IntPtr> loggedTransientHandles, ref int priorityAttempt, Action<string> log)
    {
        const int maxAttemptsPerWindow = 3;
        try
        {
            foreach (var (window, info) in FindPioneerDialogCandidates(mainHandle, mainProcessId))
            {
                var handle = info.Handle;
                if (handle == IntPtr.Zero) continue;
                if (baselineHandles.Contains(handle)) continue;

                // V-T41 (see class doc comment's "Auto-Suggest Dropdown"
                // timeout fix): a transient popup (autocomplete dropdown,
                // tooltip, etc.) is NEVER a pre-entry dialog — it must not
                // be ESC'd (that likely also cancels the field/form
                // underneath, which is exactly how the 18:53 run's repeat-
                // every-7s loop happened) or counted against
                // maxAttemptsPerWindow. Logged once per handle so it's
                // visible in app.log without spamming every ~250ms tick.
                if (DialogClassifier.IsTransientWindow(info))
                {
                    if (loggedTransientHandles.Add(handle))
                    {
                        log($"[{Name}] Ignoring transient window class '{info.ClassName}'.");
                    }
                    continue;
                }

                attempts.TryGetValue(handle, out var count);
                if (count >= maxAttemptsPerWindow) continue;

                var title = info.Title;
                attempts[handle] = count + 1;

                // NO PHI IN LOGS: same "truncate before ' - '" convention
                // as DescribeAnyPioneerWindowForLog/PioneerRxAttachment.TryAttach's
                // own DescribeForLog — a PioneerRx window title can be
                // "Rx Profile - Lastname, Firstname". `title` itself
                // (untruncated) is fine to use for classification/matching
                // and as the returned dismissed-window identifier (same as
                // before this round), but every LOG line below must use
                // screenNameOnly instead.
                var screenNameOnly = title.Split(new[] { " - " }, 2, StringSplitOptions.None)[0];

                var classificationText = BuildClassificationText(window, title);
                var kind = DialogClassifier.Classify(classificationText);

                if (kind == DialogKind.Priority)
                {
                    priorityAttempt++;
                    var announce = AutoWatchRetry.ShouldLogRetry(priorityAttempt);
                    if (announce)
                    {
                        log($"[{Name}] Unrecognized top-level window \"{screenNameOnly}\" contains \"Priority\" — treating it as the Priority dialog.");
                    }
                    HandlePriorityDialog(window, priorityAttempt, announce, log);
                    return PreEntryDialogTitles.Priority;
                }

                if (kind == DialogKind.ScanHardCopy)
                {
                    log($"[{Name}] Unrecognized top-level window \"{screenNameOnly}\" contains \"Scan\"/\"Hard Copy\" — dismissing.");
                    if (TryDismiss(window)) return PreEntryDialogTitles.ScanHardCopy;
                    continue;
                }

                if (kind == DialogKind.PatientOnCycleFill)
                {
                    log($"[{Name}] Unrecognized top-level window \"{screenNameOnly}\" contains \"Cycle Fill\" — dismissing.");
                    if (TryDismiss(window)) return PreEntryDialogTitles.PatientOnCycleFill;
                    continue;
                }

                log($"[{Name}] Unrecognized pre-entry window \"{screenNameOnly}\" (class '{SafeClassNameForLog(window)}') — pressing Escape once.");
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

    /// <summary>Title plus the first ~10 visible button/text-control names
    /// found in `window`, space-joined — enough surface for
    /// PreEntryDialogTitles.ContainsPriority/ContainsScanAndHardCopy to
    /// classify a window whose OWN title doesn't carry the recognizable
    /// word (Will's "title OR visible text" brief). Never throws; falls
    /// back to just the title on any UIA failure.
    ///
    /// NO PHI: the returned text is for MATCHING ONLY (a substring check
    /// against "Priority"/"Scan"/"Hard Copy") and must NEVER be logged —
    /// unlike a window's own title (which at least gets truncated before
    /// " - " at every log call site, see TryDismissNextStrayPioneerWindow),
    /// this string can also carry raw button/text-control content from
    /// inside the window with no truncation at all.</summary>
    private static string BuildClassificationText(AutomationElement window, string title)
    {
        var sb = new StringBuilder(title);
        try
        {
            var condition = new OrCondition(new ConditionBase[]
            {
                window.ConditionFactory.ByControlType(ControlType.Text),
                window.ConditionFactory.ByControlType(ControlType.Button),
            });

            var count = 0;
            foreach (var element in window.FindAllDescendants(condition))
            {
                if (count >= 10) break;
                var name = SafeName(element);
                if (string.IsNullOrEmpty(name)) continue;
                sb.Append(' ').Append(name);
                count++;
            }
        }
        catch
        {
            // Best-effort — title alone is still usable for classification.
        }
        return sb.ToString();
    }

    private static string SafeClassNameForLog(AutomationElement element)
    {
        try { return element.ClassName ?? "<null>"; } catch { return "<unknown>"; }
    }

    /// <summary>V-T41: true when some Pioneer top-level window OTHER THAN
    /// `mainHandle`, `foundHandle` (the just-found Add New Rx candidate —
    /// these two are frequently the SAME handle in this single-window app,
    /// but not always, see class doc comment), and anything in
    /// `baselineHandles` (windows the pharmacist already had open BEFORE
    /// F3 — same exclusion TryDismissNextStrayPioneerWindow already
    /// applies, so a legitimate second Pioneer window open for other work
    /// is never treated as a blocking modal) is both a genuine PioneerRx
    /// window and currently ENABLED — i.e. a modal is up and nothing else
    /// has recognized/dismissed it yet. Used by IsAddNewRxReady to refuse
    /// "ready" while that's true, so the combined loop keeps cycling
    /// through dismiss attempts instead of handing control to the next
    /// step with a blocking window still on screen. Best-effort/never
    /// throws — a scan failure is treated as "no blocking window seen,"
    /// same posture as every other UIA scan in this file (a false negative
    /// here just means the OLD "ready=True with a modal up" bug could
    /// still happen on a machine where this scan itself fails, not a
    /// worse outcome than before this fix).</summary>
    private static bool HasBlockingPioneerWindow(IntPtr mainHandle, IntPtr foundHandle, IReadOnlySet<IntPtr> baselineHandles, int mainProcessId)
    {
        try
        {
            foreach (var (window, info) in FindPioneerDialogCandidates(mainHandle, mainProcessId))
            {
                var handle = info.Handle;
                if (handle == IntPtr.Zero || handle == foundHandle) continue;
                if (baselineHandles.Contains(handle)) continue;
                // V-T41: a transient popup (Auto-Suggest Dropdown, tooltip,
                // etc.) never blocks readiness — see class doc comment and
                // DialogClassifier.IsTransientWindow. Without this, a
                // still-open autocomplete popup over an otherwise-ready Add
                // New Rx screen would make this loop refuse "ready" forever
                // once TryDismissNextStrayPioneerWindow stopped ESCing it.
                if (DialogClassifier.IsTransientWindow(info)) continue;

                bool isEnabled;
                try { isEnabled = window.Properties.IsEnabled.ValueOrDefault; }
                catch { isEnabled = true; } // best-effort: treat "can't tell" as potentially blocking

                if (isEnabled) return true;
            }
        }
        catch
        {
            // Best-effort only — see doc comment above.
        }
        return false;
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

    /// <summary>Scans top-level windows (combined UIA+Win32 enumeration —
    /// see PioneerWindowInventory.EnumerateAllWindows) belonging to the
    /// Pioneer process whose title satisfies `titleMatches`, optionally
    /// excluding one handle and (when `mainProcessId` > 0) scoped to that
    /// exact process id rather than merely "any process named
    /// PioneerPharmacy/PioneerRx." Never throws — treated as "not found,"
    /// same posture as PioneerRxAttachment.TryAttach.</summary>
    private static AutomationElement? FindTopLevelPioneerWindowByTitle(Func<string, bool> titleMatches, IntPtr excludeHandle = default, int mainProcessId = 0)
    {
        try
        {
            foreach (var (window, info) in PioneerWindowInventory.EnumerateAllWindows())
            {
                if (string.IsNullOrEmpty(info.Title)) continue;
                if (excludeHandle != IntPtr.Zero && info.Handle == excludeHandle) continue;
                if (mainProcessId > 0 && info.ProcessId != mainProcessId) continue;

                if (titleMatches(info.Title)) return window;
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
    /// throws.
    ///
    /// V-T41 FIX: now ALSO requires the field to be ENABLED, not merely
    /// present in the UIA tree — see class doc comment's STILL STUCK FIX
    /// section. A field can exist well before PioneerRx finishes
    /// initializing the screen (or while a modal this step doesn't
    /// recognize still covers it), and QuickSearchFieldEntry.WaitForFieldAsync's
    /// own doc comment documents exactly that same "present but disabled"
    /// gap for the SAME AutomationIds — this was the one place that gap
    /// hadn't been closed yet: declaring the whole SCREEN ready just
    /// because the field object exists, regardless of whether it's usable.</summary>
    private static bool HasNextStepField(AutomationElement window)
    {
        try
        {
            var prescriberField = window.FindFirstDescendant(cf => cf.ByAutomationId(SelectPrescriberStep.PrescriberQuickSearchAutomationId));
            if (prescriberField is not null && IsEnabledSafe(prescriberField)) return true;

            var ndcField = window.FindFirstDescendant(cf => cf.ByAutomationId(InputVaccineCodeStep.PrescribedItemQuickSearchAutomationId));
            return ndcField is not null && IsEnabledSafe(ndcField);
        }
        catch
        {
            return false;
        }
    }

    private static bool IsEnabledSafe(AutomationElement element)
    {
        try { return element.Properties.IsEnabled.ValueOrDefault; }
        catch { return false; }
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

    /// <summary>The attached main window's own OS process id — used to
    /// scope every dialog-candidate scan in this file
    /// (FindPioneerDialogCandidates via PioneerDialogCandidates.Select) to
    /// THIS SAME PioneerRx instance, not merely "any process named
    /// PioneerPharmacy/PioneerRx." Never throws — 0 on failure (Select
    /// then matches nothing, same safe-empty posture as every other UIA
    /// read in this file).</summary>
    private static int TryGetProcessId(AutomationElement window)
    {
        try { return window.FrameworkAutomationElement.ProcessId; }
        catch { return 0; }
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
