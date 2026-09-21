using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using FlaUI.Core;
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
///
/// ROUND 3 — ESCAPE LOOP FIX (V-T41, Will's 2026-09-21 17:15-17:16 log,
/// verbatim task: third round on this same bug): that night's log showed
/// the "Priority" dialog handled 6 times (throttled log lines; the raw
/// per-tick attempt count is much higher — see the timestamps: ~1.1-1.2s
/// per real attempt, so attempt 25 by 49.086s lines up with attempt 1 at
/// 22.712s) and 6 more Escape keypresses against windows with an EMPTY
/// title and class 'WindowsForms10.Window.0.*', plus TWO against a window
/// titled "ThemeManagerNotification" (.NET WinForms' own internal hidden
/// theme-change-notification window — never shown to the user, never a
/// dialog to answer) — never reaching the prescriber field in the ~55s the
/// log covers this step. ROOT CAUSE (confirmed against the code, not just
/// the log): TryDismissNextStrayPioneerWindow used to Escape ANY
/// unrecognized top-level window with no further check — including these
/// invisible owner/notification windows. Escaping one of them most likely
/// cancelled the just-opened New Rx form (or its still-open Priority
/// step) out from under the user, which is exactly why Priority kept
/// reappearing: F3's whole flow was being restarted by this step's own
/// Escapes, not by PioneerRx or the user. Compounding it:
/// RunCombinedPreEntryLoopAsync's ONLY give-up signal is `maxEmptyTicks`
/// CONSECUTIVE ticks where NOTHING was dismissed (see its own doc comment
/// and NeverBecomingReadyWithNothingToDismissTimesOutAfterMaxEmptyTicks in
/// the test suite) — and every tick in this run WAS "dismissing"
/// something (Priority, or a fresh Escape target), so `emptyTicks` reset
/// to 0 every time and the loop's nominal ~15s CombinedPreEntryLoopTimeout
/// was never actually enforced, letting a genuinely stuck run continue
/// indefinitely instead of failing loud within its stated budget.
///
/// TWO independent fixes:
///   1. DialogClassifier.IsTransientWindow now also recognizes (never
///      Escaped, never counted as blocking): any window titled
///      "ThemeManagerNotification"; tool/no-activate windows
///      (WS_EX_TOOLWINDOW/WS_EX_NOACTIVATE); and an untitled window that's
///      not visible, zero-area, not enabled, or classed
///      'WindowsForms10.Window.0.*'. And: TryDismissNextStrayPioneerWindow
///      now only Escapes an UNRECOGNIZED window once
///      DialogClassifier.IsConfirmedBlockingModal says so — the standard
///      Win32 signal that a real modal is up (its owner window disabled,
///      the candidate itself enabled) — rather than blind-ESCing whatever
///      wasn't filtered out as transient. See both methods' own doc
///      comments.
///   2. PreEntryLoopGuard (new, pure, unit-tested) is a hard circuit
///      breaker independent of fix 1: a given DialogKind handled more than
///      PreEntryLoopGuard.MaxHandledPerDialogKind times, or more than
///      PreEntryLoopGuard.MaxTotalEscapes total Escapes, in one run throws
///      PreEntryLoopProtectionException — caught in ExecuteAsync to stop
///      immediately with a clear, loud failure result AND a NO-PHI window
///      inventory log line (class, title LENGTH only, visible, enabled,
///      size, exstyle, owner handle — see WindowInfoDiagnostics) instead
///      of ever running 55+ seconds again. This also covers a genuinely
///      un-fixable-by-classification stall (e.g. Priority truly can't be
///      resolved for some other reason).
/// Every window TryDismissNextStrayPioneerWindow considers is now logged
/// with its full NO-PHI diagnostic shape plus the decision made about it
/// (ignored-nonblocking / handled-known / escaped-unknown-modal) so the
/// next stall's log is conclusive without guessing.
///
/// ROUND 4 — PRIORITY STILL NEVER CLOSES (V-T41, Will's course correction
/// on the SAME 2026-09-21 log used for ROUND 3): re-reading the timestamps,
/// the "Priority" dialog was handled ~25 raw times across 17:15:22-49 —
/// BEFORE the first Escape at 17:15:56. The Escapes did not cause the
/// Priority repeats; "typed 'Vaccine' and pressed Enter (fallback)" simply
/// never actually closed the dialog on any of those attempts, and the old
/// code logged "OK" the instant an action was ATTEMPTED, never checking
/// whether the dialog was still there on the next tick. Two changes:
///   1. "OK" now means VERIFIED — see VerifyDialogGone (waits up to ~1.5s,
///      Win32WindowEnumerator.IsWindowGone: IsWindow false or no longer
///      visible) before ANY strategy is allowed to report Resolved.
///   2. Priority resolution is now a LAYERED, exhaustive strategy pipeline
///      (PriorityDialogStrategyRunner — pure sequencing, unit-tested) run
///      to completion in ONE synchronous pass per discovery (not spread
///      re-running the same action across many combined-loop ticks):
///      (a) UIA raw-view select — TryUiaSelectStrategy uses FlaUI's RAW
///          view walker (RawViewDescendants), not the default control view
///          FindAllDescendants uses elsewhere in this file, since
///          third-party WinForms controls often hide from the control
///          view. Finds the first ComboBox/List/DataGrid/Custom/Edit and,
///          for a ComboBox, expands it and searches for an item whose name
///          STARTS WITH "Vaccine" (PriorityValueMatcher.StartsWith) both
///          in the combo's own subtree AND — this is the actual root-cause
///          fix, see point 3 below — in a separate same-process top-level
///          'ComboLBox' popup window (ComboLBoxWindowLocator/
///          FindComboLBoxElement) if the combo's own subtree has nothing.
///      (b) Keyboard type-ahead — TryKeyboardStrategy verifies the dialog
///          is the FOREGROUND window (Win32WindowEnumerator.
///          IsForegroundWindow/TryBringToForeground) before sending any
///          keys, opens a collapsed combo with Alt+Down, clicks the
///          control's rect centre to focus it, types "V", and verifies
///          (ReadControlValue) the resulting value/selection actually
///          starts with "Vaccine" BEFORE confirming.
///      Both strategies share step (c) Confirm (TryConfirmDialog, widened
///      to match OK/Select/Save/Continue/Accept by name or AutomationId,
///      Enter, then Alt+O) and both end by calling VerifyDialogGone.
///      (d) If every strategy leaves the dialog open: ONE redacted raw UIA
///          tree dump (DumpPriorityDialogRedacted — class/AutomationId/
///          patterns/name-only-when-short-and-digit-free, depth <= 6,
///          <= 300 nodes) is logged, then PriorityDialogUnresolvedException
///          is thrown — caught in ExecuteAsync to fail the WHOLE STEP loud
///          with a message telling the user to pick "Vaccine" manually,
///          rather than looping or silently continuing with the dialog
///          still open.
///   3. ROOT CAUSE of "FAILED to find a selectable 'Vaccine' item (no
///      matching ComboBox/ListBox/Data...)": the log's own
///      "Ignoring transient window class 'ComboLBox'" lines, right
///      alongside the Priority failures, are the tell — a standard Win32
///      combo box's drop-down list renders as a SEPARATE TOP-LEVEL window
///      (class 'ComboLBox'), never a descendant of the dialog/combo that
///      owns it, so no amount of subtree-scanning could ever find the
///      "Vaccine" item there. DialogClassifier.IsTransientWindowClass
///      already, correctly, never Escapes/blocks on that window (unchanged
///      by this round) — TryUiaSelectStrategy above is the other half:
///      actively searching that SAME window for the item once the combo's
///      own subtree comes up empty.
///   4. Loop-guard attempt counting (PreEntryLoopGuard, kept from ROUND 3)
///      now naturally counts one PASS per discovery instead of one per
///      tick, since a pass either resolves or throws within a single
///      synchronous call — see TryHandlePriorityIfShowing's own doc
///      comment.
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
        var loggedIgnoredHandles = new HashSet<IntPtr>();
        var priorityAttempt = 0;
        var loopGuard = new PreEntryLoopGuard();
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

        // V-T41 ROUND 3: wraps TryDismissNextPendingDialogOrStrayWindow with
        // PreEntryLoopGuard's hard circuit breaker — see class doc
        // comment's ROUND 3 section. `title` is exactly
        // PreEntryDialogTitles.Priority only when the Priority dialog was
        // select+confirmed (never Escaped); every other non-null title
        // (a known-title Escape, or an unrecognized-but-confirmed-modal
        // Escape) corresponds to one real Escape keypress.
        string? TryDismissNext()
        {
            var title = TryDismissNextPendingDialogOrStrayWindow(
                attachedWindow, baselineHandles, previousHandle, mainProcessId, strayAttempts, loggedIgnoredHandles, ref priorityAttempt, context.Log);
            if (title is null) return null;

            var kind = title == PreEntryDialogTitles.Priority ? DialogKind.Priority : DialogClassifier.Classify(title);
            if (loopGuard.RecordHandled(kind))
            {
                throw new PreEntryLoopProtectionException(
                    $"the \"{title}\" dialog/window was handled more than {PreEntryLoopGuard.MaxHandledPerDialogKind} times in this run without ever reaching \"Add New Rx\"");
            }
            if (title != PreEntryDialogTitles.Priority && loopGuard.RecordEscape())
            {
                throw new PreEntryLoopProtectionException(
                    $"more than {PreEntryLoopGuard.MaxTotalEscapes} Escape keypresses were sent to pre-entry windows in this run without ever reaching \"Add New Rx\"");
            }
            return title;
        }

        var loopStopwatch = Stopwatch.StartNew();
        CombinedPreEntryLoopResult loopResult;
        try
        {
            loopResult = await RunCombinedPreEntryLoopAsync(
                IsAddNewRxReady, TryDismissNext, TicksFor(CombinedPreEntryLoopTimeout), WaitTick, cancellationToken);
        }
        catch (PreEntryLoopProtectionException ex)
        {
            var inventory = DescribeWindowInventoryNoPhi(previousHandle, mainProcessId);
            context.Log($"[{Name}] Loop protection stopped this run: {ex.Message} — PioneerRx window inventory: {inventory}");
            return new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                $"Stopped to avoid an infinite retry loop: {ex.Message}. This usually means a non-dialog Pioneer " +
                "window was being Escaped and restarting the New Rx flow. See app.log for the window inventory " +
                "(class/visibility/enabled/size/style — no titles logged).");
        }
        catch (PriorityDialogUnresolvedException ex)
        {
            // V-T41 ROUND 4: every layered Priority strategy ran, was
            // verified NOT to have closed the dialog, and a redacted raw
            // UIA dump was already logged by ResolvePriorityDialog — this
            // is a deliberate, definitive failure (not the recoverable/
            // stalled shape the generic catch below classifies), so it
            // fails loud immediately with a clear, actionable message
            // instead of falling through to AutoWatchErrorClassifier.
            context.Log($"[{Name}] {ex.Message}");
            return new PioneerEntryStepResult(Name, Success: false, DryRun: false, ex.Message);
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

    /// <summary>V-T41 ROUND 4 REVIEW FIX (non-blocking, safety reviewer):
    /// a real wall-clock ceiling on the WHOLE combined loop, independent of
    /// maxEmptyTicks — the reviewer's concrete worry is a run that keeps
    /// "making progress" (some dismissal or Priority pass on every tick, so
    /// emptyTicks never accumulates) but never actually reaches "Add New
    /// Rx," the exact shape PreEntryLoopGuard was added for in Priority's
    /// own case but which this loop has no OWN backstop against for other
    /// causes. Defaults to 30s (Default field below) when the caller
    /// (ExecuteAsync) doesn't override it.</summary>
    public static readonly TimeSpan DefaultAbsoluteDeadline = TimeSpan.FromSeconds(30);

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
    ///
    /// V-T41 ROUND 4 REVIEW FIX: `absoluteDeadline` (default
    /// DefaultAbsoluteDeadline, 30s) and `now` (default real
    /// DateTime.UtcNow — overridable so this stays unit-testable with a
    /// fake clock, no real sleeping) add a SECOND, independent give-up
    /// signal: the elapsed wall-clock time since the loop started, checked
    /// every tick BEFORE isAddNewRxReady/tryDismissNextPending. Exceeding
    /// it throws PreEntryLoopProtectionException — the same "fail loud with
    /// a window inventory dump" path PreEntryLoopGuard already uses — since
    /// a run that keeps "making progress" every tick (so emptyTicks never
    /// accumulates) would otherwise never trip the maxEmptyTicks guard at
    /// all, no matter how long it actually ran.
    /// </summary>
    public static async Task<CombinedPreEntryLoopResult> RunCombinedPreEntryLoopAsync(
        Func<bool> isAddNewRxReady,
        Func<string?> tryDismissNextPending,
        int maxEmptyTicks,
        Func<Task> waitTick,
        CancellationToken cancellationToken = default,
        TimeSpan? absoluteDeadline = null,
        Func<DateTime>? now = null)
    {
        var dismissed = new List<string>();
        var emptyTicks = 0;
        var deadline = absoluteDeadline ?? DefaultAbsoluteDeadline;
        var clock = now ?? (static () => DateTime.UtcNow);
        var start = clock();

        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (clock() - start > deadline)
            {
                throw new PreEntryLoopProtectionException(
                    $"the combined pre-entry loop exceeded its {deadline.TotalSeconds:0}s absolute deadline without the \"Add New Rx\" screen ever becoming ready");
            }

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
        Dictionary<IntPtr, int> strayAttempts, HashSet<IntPtr> loggedIgnoredHandles, ref int priorityAttempt, Action<string> log)
    {
        if (TryHandlePriorityIfShowing(attachedWindow, mainHandle, mainProcessId, ref priorityAttempt, log))
        {
            return PreEntryDialogTitles.Priority;
        }

        foreach (var title in PreEntryDialogTitles.All)
        {
            if (title == PreEntryDialogTitles.Priority) continue; // handled above — select+confirm, not ESC
            if (TryDismissIfShowing(attachedWindow, title, mainHandle, mainProcessId, log)) return title;
        }

        // V-T41 ROUND 3: the main window's OWN enabled state right now —
        // see DialogClassifier.IsConfirmedBlockingModal's doc comment for
        // why this is the signal TryDismissNextStrayPioneerWindow needs
        // before it may Escape an UNRECOGNIZED window. Deliberately NOT
        // IsEnabledSafe (that helper returns false — "not enabled" — on a
        // read failure, which is the wrong fail-safe direction here: it
        // would make an unrecognized window MORE likely to look like a
        // confirmed blocking modal and get Escaped). "Can't tell" must mean
        // "assume the main window IS enabled" so nothing is confirmed as
        // blocking and this step never Escapes blind on a read failure.
        bool mainWindowEnabled;
        try { mainWindowEnabled = attachedWindow.Properties.IsEnabled.ValueOrDefault; }
        catch { mainWindowEnabled = true; }
        return TryDismissNextStrayPioneerWindow(baselineHandles, mainHandle, mainProcessId, strayAttempts, loggedIgnoredHandles, ref priorityAttempt, mainWindowEnabled, log);
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
    private bool TryDismissIfShowing(AutomationElement attachedWindow, string titleSubstring, IntPtr mainHandle, int mainProcessId, Action<string> log)
    {
        foreach (var (element, info) in FindPioneerDialogCandidates(mainHandle, mainProcessId))
        {
            if (PreEntryDialogTitles.MatchesWithAliases(info.Title, titleSubstring))
            {
                log($"[{Name}] \"{titleSubstring}\" dialog matched — {WindowInfoDiagnostics.DescribeNoPhiWithDecision(info, "handled-known")}.");
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

    /// <summary>V-T41 ROUND 3: NO-PHI (title LENGTH only — see
    /// WindowInfoDiagnostics' own doc comment) inventory of every
    /// dialog-candidate window, for PreEntryLoopProtectionException's
    /// failure log — deliberately distinct from
    /// PioneerWindowInventory.Describe() (which logs a truncated but still
    /// partial title) since this dump is reached specifically because
    /// something already went wrong and titles must not risk carrying a
    /// patient name into the log. Never throws.</summary>
    private static string DescribeWindowInventoryNoPhi(IntPtr mainHandle, int mainProcessId)
    {
        try
        {
            var candidates = FindPioneerDialogCandidates(mainHandle, mainProcessId);
            if (candidates.Count == 0) return "no non-main PioneerRx window found.";
            return string.Join(" \\ ", candidates.Select(c => WindowInfoDiagnostics.DescribeNoPhi(c.Info)));
        }
        catch (Exception ex)
        {
            return $"<window inventory failed: {ex.GetType().Name}: {ex.Message}>";
        }
    }

    /// <summary>
    /// PRIORITY POPUP FIX (see class doc comment) — finds the "Priority"
    /// dialog the same way TryDismissIfShowing finds every other pre-entry
    /// dialog (top-level Pioneer window first, then a UIA descendant of
    /// the attached window). Returns false (no dialog found — caller moves
    /// on to the plain ESC-dismiss titles) or true (dialog found and a
    /// FULL resolution pass — see ResolvePriorityDialog — was run; that
    /// pass either resolves the dialog or throws
    /// PriorityDialogUnresolvedException, it never returns having merely
    /// "tried something" the way the pre-ROUND-4 version did).
    ///
    /// V-T41 ROUND 4: `attempt` now counts one PASS (a full run through
    /// every strategy in ResolvePriorityDialog), not one tick — see class
    /// doc comment's ROUND 4 section for why that distinction matters. Both
    /// callers (this method, and TryDismissNextStrayPioneerWindow's
    /// broadened "unrecognized window contains 'Priority'" match) share ONE
    /// counter, threaded by ref through TryDismissNextPendingDialogOrStrayWindow,
    /// so pass numbers in the log stay sequential regardless of which path
    /// found the dialog.
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
        log($"[{Name}] \"Priority\" dialog: resolving (pass {attempt}, target \"{_priorityValue}\")...");
        ResolvePriorityDialog(dialog, mainProcessId, log);
        return true;
    }

    /// <summary>
    /// V-T41 ROUND 4 (Will's 2026-09-21 brief): runs every layered
    /// Priority-resolution strategy in order (see
    /// PriorityDialogStrategyRunner) — UIA raw-view select, then keyboard
    /// type-ahead — stopping at the first one VERIFIED to have closed the
    /// dialog (see VerifyDialogGone; a strategy is never trusted just
    /// because it "did something"). If every strategy runs out having left
    /// the dialog open, logs a ONE-TIME redacted raw UIA dump (point (d) of
    /// the brief — class/AutomationId/patterns/name-or-length only, never
    /// full field text) and throws PriorityDialogUnresolvedException, which
    /// ExecuteAsync catches to fail this step loud with a message telling
    /// the user to pick "Vaccine" manually rather than grinding forever or
    /// silently moving on with the dialog still blocking data entry.
    /// </summary>
    private void ResolvePriorityDialog(AutomationElement dialog, int mainProcessId, Action<string> log)
    {
        var dialogHandle = SafeNativeHandle(dialog);

        var strategies = new List<PriorityStrategyStep>
        {
            new("UIA raw-view select", () => TryUiaSelectStrategy(dialog, dialogHandle, mainProcessId, log)),
            new("keyboard type-ahead", () => TryKeyboardStrategy(dialog, dialogHandle, mainProcessId, log)),
        };

        var resolvedBy = PriorityDialogStrategyRunner.Run(strategies, (n, total, name, outcome) =>
            log($"[{Name}] \"Priority\" dialog: strategy {n}/{total} ({name}) -> {outcome}."));

        if (resolvedBy is not null)
        {
            log($"[{Name}] \"Priority\" dialog: OK — verified closed via {resolvedBy}.");
            return;
        }

        var dump = DumpPriorityDialogRedacted(dialog);
        log($"[{Name}] \"Priority\" dialog: FAILED-still-open — every strategy exhausted. Redacted raw UIA dump follows:\n{dump}");
        throw new PriorityDialogUnresolvedException(
            $"Couldn't automatically set \"Priority\" to \"{_priorityValue}\" in PioneerRx after trying every known " +
            "strategy — the dialog is still open. Please select it manually, then continue.");
    }

    /// <summary>
    /// V-T41 ROUND 4 REVIEW FIX (BLOCKER 1 — safety reviewer): "build ONE
    /// helper that verifies, immediately before EVERY key chord/click in
    /// the Priority strategies, that the dialog HWND is alive+visible AND
    /// is either the foreground window OR the foreground is a ComboLBox
    /// popup owned by the same Pioneer process id; refuse (no send)
    /// otherwise. Route ALL Priority-strategy input through it." Every
    /// boolean is re-gathered FRESH on each call (never cached/reused
    /// across sends) — a prior TryBringToForeground call is never trusted
    /// blind; SelectionItem/LegacyIAccessible/Invoke UIA pattern calls
    /// target a specific element's own COM provider directly and are NOT
    /// routed through this (lower risk — see class doc comment's
    /// ROUND 4 REVIEW FIX section); only raw OS-level Keyboard/Mouse input
    /// (which goes to whatever window currently has OS focus/foreground,
    /// not necessarily the window a caller intends) is. Fails SAFE: any
    /// read failure is treated as "not authorized," never as "assume
    /// it's fine" (the opposite default direction of IsEnabledSafe — see
    /// class doc comment's fail-safe-direction note). Never throws.
    /// </summary>
    private bool TryAuthorizeDialogInput(IntPtr dialogHandle, int mainProcessId, string what, Action<string> log)
    {
        bool aliveAndVisible;
        try { aliveAndVisible = !Win32WindowEnumerator.IsWindowGone(dialogHandle); }
        catch { aliveAndVisible = false; }

        IntPtr foreground;
        try { foreground = Win32WindowEnumerator.GetForegroundWindowHandle(); }
        catch { foreground = IntPtr.Zero; }

        var isDialogForeground = aliveAndVisible && foreground != IntPtr.Zero && foreground == dialogHandle;

        var isComboPopupForeground = false;
        if (aliveAndVisible && !isDialogForeground && foreground != IntPtr.Zero)
        {
            try
            {
                var info = Win32WindowEnumerator.Describe(foreground);
                isComboPopupForeground =
                    info.ProcessId == mainProcessId &&
                    string.Equals(info.ClassName, "ComboLBox", StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                isComboPopupForeground = false;
            }
        }

        var authorized = PriorityInputGuard.CanSendInput(aliveAndVisible, isDialogForeground, isComboPopupForeground);
        if (!authorized)
        {
            log($"[{Name}] \"Priority\" dialog: input guard REFUSED \"{what}\" — " +
                $"alive={aliveAndVisible}, dialogForeground={isDialogForeground}, comboPopupForeground={isComboPopupForeground}.");
        }
        return authorized;
    }

    /// <summary>
    /// STRATEGY (a) — UIA raw-view select (brief point 2a). Uses the RAW
    /// view (FlaUI's TreeWalkerFactory.GetRawViewWalker(), not the default
    /// control view FindAllDescendants uses elsewhere in this file) because
    /// third-party WinForms controls often hide from the control view
    /// entirely — see class doc comment's ROUND 4 section. For each
    /// ComboBox/List/DataGrid/Custom/Edit candidate found (in that order):
    /// a ComboBox is expanded, then searched for a "Vaccine"-starting item
    /// first in its own raw subtree and, if not found there (brief point
    /// 3), in a SEPARATE same-process top-level 'ComboLBox' popup window
    /// (standard Win32 combo behaviour — its drop-down list is its own
    /// top-level window, never a descendant of the combo/dialog); a
    /// List/DataGrid/Custom is searched directly; an Edit has its Value set
    /// directly. Whichever candidate yields a match is selected (see
    /// TrySelectMatchedItem), the dialog is confirmed (step (c) —
    /// TryConfirmDialog), and the outcome reflects whether the dialog was
    /// VERIFIED closed afterward (VerifyDialogGone) — never merely whether
    /// an action was attempted.
    /// </summary>
    private PriorityStrategyOutcome TryUiaSelectStrategy(AutomationElement dialog, IntPtr dialogHandle, int mainProcessId, Action<string> log)
    {
        List<AutomationElement> candidates;
        try
        {
            candidates = FindSelectionControlCandidates(dialog);
        }
        catch (Exception ex)
        {
            log($"[{Name}] \"Priority\" dialog: UIA strategy — error walking the raw view: {ex.Message}.");
            return PriorityStrategyOutcome.NotFound;
        }

        if (candidates.Count == 0)
        {
            log($"[{Name}] \"Priority\" dialog: UIA strategy — no ComboBox/List/DataGrid/Custom/Edit control found via raw view walk.");
            return PriorityStrategyOutcome.NotFound;
        }

        foreach (var control in candidates)
        {
            var matched = TryMatchAndSelectControl(control, dialogHandle, mainProcessId, log);
            if (!matched) continue;

            log($"[{Name}] \"Priority\" dialog: UIA strategy — selected \"{_priorityValue}\"; confirming...");
            TryConfirmDialog(dialog, dialogHandle, mainProcessId, log);
            return VerifyDialogGone(dialogHandle) ? PriorityStrategyOutcome.Resolved : PriorityStrategyOutcome.StillOpen;
        }

        log($"[{Name}] \"Priority\" dialog: UIA strategy — found {candidates.Count} candidate control(s) but none exposed a \"{_priorityValue}\" item.");
        return PriorityStrategyOutcome.NotFound;
    }

    /// <summary>Per-control matching for TryUiaSelectStrategy — returns the
    /// matched/acted-on element (truthy "something was selected/set") or
    /// null ("this control had nothing usable"). Never throws.</summary>
    private bool TryMatchAndSelectControl(AutomationElement control, IntPtr dialogHandle, int mainProcessId, Action<string> log)
    {
        ControlType controlType;
        try { controlType = control.ControlType; }
        catch { return false; }

        if (controlType == ControlType.ComboBox)
        {
            try
            {
                if (control.Patterns.ExpandCollapse.IsSupported)
                {
                    control.Patterns.ExpandCollapse.Pattern.Expand();
                }
            }
            catch
            {
                // Best-effort — some combos list items without an explicit expand.
            }

            var matched = FindVaccineItem(RawViewDescendants(control, maxDepth: 4));

            if (matched is null)
            {
                // Brief point 3: the drop-down list is its own top-level
                // 'ComboLBox' window, not a descendant of the combo/dialog.
                var popup = FindComboLBoxElement(mainProcessId);
                if (popup is not null)
                {
                    matched = FindVaccineItem(RawViewDescendants(popup, maxDepth: 3));
                    if (matched is not null)
                    {
                        log($"[{Name}] \"Priority\" dialog: UIA strategy — found \"{_priorityValue}\" in the separate 'ComboLBox' popup window.");
                    }
                }
            }

            var selected = matched is not null && TrySelectMatchedItem(matched, dialogHandle, mainProcessId, log);

            try
            {
                if (control.Patterns.ExpandCollapse.IsSupported)
                {
                    control.Patterns.ExpandCollapse.Pattern.Collapse();
                }
            }
            catch
            {
                // Best-effort.
            }

            return selected;
        }

        if (controlType == ControlType.Edit)
        {
            try
            {
                if (control.Patterns.Value.IsSupported && IsEnabledSafe(control))
                {
                    control.Patterns.Value.Pattern.SetValue(_priorityValue);
                    return true;
                }
            }
            catch
            {
                // Treated as "this Edit didn't work" — caller moves to the next candidate.
            }
            return false;
        }

        // List / DataGrid / Custom — search directly for a matching item.
        var item = FindVaccineItem(RawViewDescendants(control, maxDepth: 4));
        return item is not null && TrySelectMatchedItem(item, dialogHandle, mainProcessId, log);
    }

    /// <summary>Raw-view (FlaUI TreeWalkerFactory.GetRawViewWalker()) walk
    /// of every descendant of `root`, up to `maxDepth` — the raw view
    /// exposes elements the default control view can hide, which matters
    /// for third-party WinForms controls (brief point 2a). Never throws;
    /// returns whatever was collected before any failure.</summary>
    private static List<AutomationElement> RawViewDescendants(AutomationElement root, int maxDepth)
    {
        var results = new List<AutomationElement>();
        try
        {
            var walker = root.Automation.TreeWalkerFactory.GetRawViewWalker();
            Walk(root, 0);

            void Walk(AutomationElement element, int depth)
            {
                if (depth > maxDepth) return;
                AutomationElement? child;
                try { child = walker.GetFirstChild(element); }
                catch { return; }

                while (child is not null)
                {
                    results.Add(child);
                    Walk(child, depth + 1);
                    try { child = walker.GetNextSibling(child); }
                    catch { break; }
                }
            }
        }
        catch
        {
            // Best-effort — return whatever was collected so far.
        }
        return results;
    }

    private static readonly ControlType[] PrioritySelectionControlTypes =
    {
        ControlType.ComboBox, ControlType.List, ControlType.DataGrid, ControlType.Custom, ControlType.Edit,
    };

    /// <summary>Every raw-view descendant of `dialog` whose ControlType is
    /// one of PrioritySelectionControlTypes, in encounter order (ComboBox
    /// naturally tends to come first in these dialogs, matching the brief's
    /// listed priority order). Never throws.</summary>
    private static List<AutomationElement> FindSelectionControlCandidates(AutomationElement dialog)
    {
        var candidates = new List<AutomationElement>();
        foreach (var element in RawViewDescendants(dialog, maxDepth: 6))
        {
            ControlType controlType;
            try { controlType = element.ControlType; }
            catch { continue; }
            if (Array.IndexOf(PrioritySelectionControlTypes, controlType) >= 0)
            {
                candidates.Add(element);
            }
        }
        return candidates;
    }

    /// <summary>
    /// V-T41 ROUND 4 REVIEW FIX (non-blocking, safety reviewer): "try an
    /// exact 'Vaccine' match first, then starts-with, as a fallback" —
    /// delegates to PriorityValueMatcher.FindBestMatchIndex (pure
    /// precedence orchestration, unit-tested on its own) rather than the
    /// single starts-with-only linear scan this used to be, so an exact
    /// "Vaccine" item is always preferred over a merely-starts-with one
    /// like "Vaccine Administration." Never throws.
    /// </summary>
    private AutomationElement? FindVaccineItem(IEnumerable<AutomationElement> elements)
    {
        var candidates = elements as IReadOnlyList<AutomationElement> ?? elements.ToList();
        var names = new List<string?>(candidates.Count);
        foreach (var element in candidates) names.Add(SafeName(element));

        var index = PriorityValueMatcher.FindBestMatchIndex(names, _priorityValue);
        return index >= 0 ? candidates[index] : null;
    }

    /// <summary>V-T41 ROUND 4 point 3 — locates the same-process top-level
    /// 'ComboLBox' popup window (ComboLBoxWindowLocator's pure filter,
    /// applied against a live PioneerWindowInventory.EnumerateAllWindows()
    /// scan) and returns its AutomationElement. Never throws.</summary>
    private static AutomationElement? FindComboLBoxElement(int mainProcessId)
    {
        try
        {
            var all = PioneerWindowInventory.EnumerateAllWindows();
            var match = ComboLBoxWindowLocator.Find(all.Select(pair => pair.Info), mainProcessId);
            if (match is null) return null;
            foreach (var (element, info) in all)
            {
                if (info.Handle == match.Value.Handle) return element;
            }
        }
        catch
        {
            // Best-effort — see doc comment above.
        }
        return null;
    }

    /// <summary>Brief point 2a: "select the matching item (SelectionItem /
    /// LegacyIAccessible DoDefaultAction) or double-click its bounding rect
    /// centre." Tried in that order. The first two target the item's own
    /// UIA provider directly (COM-targeted, not raw OS input) so they are
    /// NOT gated; the double-click fallback IS raw Mouse input that goes to
    /// whatever window currently has OS focus, so it's gated via
    /// TryAuthorizeDialogInput first (BLOCKER 1 — safety reviewer). Never
    /// throws.</summary>
    private bool TrySelectMatchedItem(AutomationElement item, IntPtr dialogHandle, int mainProcessId, Action<string> log)
    {
        try
        {
            if (item.Patterns.SelectionItem.IsSupported)
            {
                item.Patterns.SelectionItem.Pattern.Select();
                return true;
            }
        }
        catch
        {
            // Fall through to the next selection method.
        }

        try
        {
            if (item.Patterns.LegacyIAccessible.IsSupported)
            {
                item.Patterns.LegacyIAccessible.Pattern.DoDefaultAction();
                return true;
            }
        }
        catch
        {
            // Fall through to the double-click fallback.
        }

        try
        {
            var rect = item.BoundingRectangle;
            if (!rect.IsEmpty)
            {
                if (!TryAuthorizeDialogInput(dialogHandle, mainProcessId, "double-click matched item", log)) return false;
                Mouse.LeftDoubleClick(new Point(rect.X + rect.Width / 2, rect.Y + rect.Height / 2));
                return true;
            }
        }
        catch
        {
            // Treated as "couldn't select this candidate."
        }
        return false;
    }

    /// <summary>
    /// STRATEGY (b) — keyboard type-ahead into the FOCUSED dialog only
    /// (brief point 2b). Verifies foreground == dialog hwnd first (bringing
    /// it forward if not — Windows delivers keystrokes to whichever window
    /// has focus, not necessarily the one this code intends), finds the
    /// same shape of selection control TryUiaSelectStrategy looks for,
    /// opens it (Alt+Down) if it's a currently-collapsed ComboBox, clicks
    /// its rect centre to focus it, types "V" (classic Win32 combo/list
    /// type-ahead), and verifies the control's resulting value/selection
    /// actually starts with `_priorityValue` (ReadControlValue) BEFORE
    /// attempting to confirm — a type-ahead that landed on the wrong item
    /// (or nothing) must not be blindly confirmed. Outcome again reflects
    /// VerifyDialogGone, never merely "an action was attempted."
    /// </summary>
    private PriorityStrategyOutcome TryKeyboardStrategy(AutomationElement dialog, IntPtr dialogHandle, int mainProcessId, Action<string> log)
    {
        if (!Win32WindowEnumerator.IsForegroundWindow(dialogHandle))
        {
            log($"[{Name}] \"Priority\" dialog: keyboard strategy — dialog isn't the foreground window; bringing it forward.");
            Win32WindowEnumerator.TryBringToForeground(dialogHandle);
        }

        List<AutomationElement> candidates;
        try { candidates = FindSelectionControlCandidates(dialog); }
        catch { candidates = new List<AutomationElement>(); }

        var control = candidates.FirstOrDefault();
        if (control is null)
        {
            log($"[{Name}] \"Priority\" dialog: keyboard strategy — no selection control found to focus.");
            return PriorityStrategyOutcome.NotFound;
        }

        try
        {
            var isCollapsedCombo =
                SafeControlType(control) == ControlType.ComboBox &&
                control.Patterns.ExpandCollapse.IsSupported &&
                control.Patterns.ExpandCollapse.Pattern.ExpandCollapseState.ValueOrDefault == ExpandCollapseState.Collapsed;
            if (isCollapsedCombo)
            {
                // V-T41 ROUND 4 REVIEW FIX (BLOCKER 1 — safety reviewer):
                // TryBringToForeground above is NEVER trusted blind —
                // re-verified fresh immediately before this send, and
                // before every send after it.
                if (!TryAuthorizeDialogInput(dialogHandle, mainProcessId, "Alt+Down", log))
                {
                    return PriorityStrategyOutcome.StillOpen;
                }
                Keyboard.TypeSimultaneously(new[] { VirtualKeyShort.ALT, VirtualKeyShort.DOWN });
            }

            var rect = control.BoundingRectangle;
            if (!rect.IsEmpty)
            {
                if (!TryAuthorizeDialogInput(dialogHandle, mainProcessId, "click selection control", log))
                {
                    return PriorityStrategyOutcome.StillOpen;
                }
                Mouse.LeftClick(new Point(rect.X + rect.Width / 2, rect.Y + rect.Height / 2));
            }
            else
            {
                control.FocusNative();
            }

            if (!TryAuthorizeDialogInput(dialogHandle, mainProcessId, "type \"V\"", log))
            {
                return PriorityStrategyOutcome.StillOpen;
            }
            Keyboard.Type("V");
        }
        catch (Exception ex)
        {
            log($"[{Name}] \"Priority\" dialog: keyboard strategy — error focusing/typing: {ex.Message}.");
            return PriorityStrategyOutcome.StillOpen;
        }

        var currentValue = ReadControlValue(control);
        if (!PriorityValueMatcher.StartsWith(currentValue, _priorityValue))
        {
            log($"[{Name}] \"Priority\" dialog: keyboard strategy — type-ahead \"V\" did not select \"{_priorityValue}\" " +
                $"(current value length {currentValue?.Length ?? 0}).");
            return PriorityStrategyOutcome.StillOpen;
        }

        log($"[{Name}] \"Priority\" dialog: keyboard strategy — type-ahead selected \"{_priorityValue}\"; confirming...");
        TryConfirmDialog(dialog, dialogHandle, mainProcessId, log);
        return VerifyDialogGone(dialogHandle) ? PriorityStrategyOutcome.Resolved : PriorityStrategyOutcome.StillOpen;
    }

    private static ControlType SafeControlType(AutomationElement element)
    {
        try { return element.ControlType; }
        catch { return ControlType.Custom; }
    }

    /// <summary>Reads back what the keyboard strategy's type-ahead actually
    /// selected: the control's own Value (ValuePattern) first, falling back
    /// to whichever ListItem/DataItem descendant now reports itself
    /// selected (SelectionItemPattern.IsSelected) — a plain ComboBox/List
    /// often only exposes the latter. Never throws.</summary>
    private static string? ReadControlValue(AutomationElement control)
    {
        try
        {
            if (control.Patterns.Value.IsSupported)
            {
                var value = control.Patterns.Value.Pattern.Value.ValueOrDefault;
                if (!string.IsNullOrEmpty(value)) return value;
            }
        }
        catch
        {
            // Fall through to the selected-item fallback below.
        }

        try
        {
            var condition = new OrCondition(new ConditionBase[]
            {
                control.ConditionFactory.ByControlType(ControlType.ListItem),
                control.ConditionFactory.ByControlType(ControlType.DataItem),
            });
            foreach (var item in control.FindAllDescendants(condition))
            {
                if (item.Patterns.SelectionItem.IsSupported && item.Patterns.SelectionItem.Pattern.IsSelected.ValueOrDefault)
                {
                    return SafeName(item);
                }
            }
        }
        catch
        {
            // Best-effort — see doc comment above.
        }
        return null;
    }

    /// <summary>V-T41 ROUND 4 point 1: "make 'OK' mean VERIFIED" — waits up
    /// to ~1.5s (15 ticks * 100ms) for the dialog's own HWND to actually be
    /// gone (Win32WindowEnumerator.IsWindowGone — IsWindow false, or no
    /// longer visible) before a strategy is allowed to report Resolved.
    /// Synchronous (Thread.Sleep, not the async WaitTick used elsewhere in
    /// this step) — see SynchronousPoll's own doc comment for why.</summary>
    private static bool VerifyDialogGone(IntPtr dialogHandle) =>
        SynchronousPoll.WaitUntil(() => Win32WindowEnumerator.IsWindowGone(dialogHandle), maxTicks: 15, () => Thread.Sleep(100));

    /// <summary>Step (c) — Confirm. Brief point 2c: a button named OK /
    /// Select / Save / Continue / Accept (case-insensitive; also matches by
    /// AutomationId containing "ok"/"accept") -> Invoke; else a plain Enter
    /// to the dialog; else Alt+O.
    ///
    /// V-T41 ROUND 4 REVIEW FIX (BLOCKER 2 — safety reviewer): "if the
    /// dialog is already gone -> return Resolved (nothing to confirm, no
    /// action); route Enter/Alt+O only through the new [input guard]
    /// helper; drop the blind Alt+O send when not verifiably foreground."
    /// The button search stays strictly scoped to `dialog`'s own subtree
    /// (FindAllDescendants off `dialog`, never a desktop-wide search) —
    /// unchanged, preserved per the reviewer's explicit note. Invoke on a
    /// found button targets that button's own UIA provider directly
    /// (COM-targeted, not raw OS input) so it's NOT gated; every Enter/
    /// Alt+O keystroke IS raw OS input, so each is gated via
    /// TryAuthorizeDialogInput immediately before it's sent — a refusal
    /// simply means "don't send this one," not an exception, so the method
    /// falls through toward the next fallback rather than aborting. Never
    /// throws.</summary>
    private static readonly string[] ConfirmButtonNames = { "OK", "Select", "Save", "Continue", "Accept" };

    private bool TryConfirmDialog(AutomationElement dialog, IntPtr dialogHandle, int mainProcessId, Action<string> log)
    {
        if (Win32WindowEnumerator.IsWindowGone(dialogHandle))
        {
            log($"[{Name}] \"Priority\" dialog: confirm — dialog is already gone; nothing to confirm.");
            return true;
        }

        try
        {
            var buttonCondition = dialog.ConditionFactory.ByControlType(ControlType.Button);
            foreach (var button in dialog.FindAllDescendants(buttonCondition))
            {
                var name = SafeName(button);
                var automationId = SafeAutomationId(button);
                var nameMatches = ConfirmButtonNames.Any(candidate => name.Contains(candidate, StringComparison.OrdinalIgnoreCase));
                var idMatches =
                    automationId.Contains("ok", StringComparison.OrdinalIgnoreCase) ||
                    automationId.Contains("accept", StringComparison.OrdinalIgnoreCase);
                if (!nameMatches && !idMatches) continue;

                if (button.Patterns.Invoke.IsSupported)
                {
                    button.Patterns.Invoke.Pattern.Invoke();
                    return true;
                }

                if (TryAuthorizeDialogInput(dialogHandle, mainProcessId, "Enter on confirm button", log))
                {
                    button.FocusNative();
                    Keyboard.Type(VirtualKeyShort.RETURN);
                    return true;
                }
                return false;
            }
        }
        catch
        {
            // Fall through to the plain Enter fallback below.
        }

        if (Win32WindowEnumerator.IsWindowGone(dialogHandle))
        {
            log($"[{Name}] \"Priority\" dialog: confirm — dialog closed while searching for a button; nothing further to do.");
            return true;
        }

        try
        {
            if (TryAuthorizeDialogInput(dialogHandle, mainProcessId, "Enter on dialog", log))
            {
                dialog.FocusNative();
                Keyboard.Type(VirtualKeyShort.RETURN);
                return true;
            }
        }
        catch
        {
            // Fall through to Alt+O below.
        }

        try
        {
            if (TryAuthorizeDialogInput(dialogHandle, mainProcessId, "Alt+O", log))
            {
                Keyboard.TypeSimultaneously(new[] { VirtualKeyShort.ALT, VirtualKeyShort.KEY_O });
                return true;
            }
        }
        catch
        {
            // Treated as "couldn't confirm" below.
        }
        return false;
    }

    private static string SafeAutomationId(AutomationElement element)
    {
        try { return element.AutomationId ?? ""; }
        catch { return ""; }
    }

    /// <summary>Step (d) — brief point 2d: "ONE-TIME redacted UIA raw-tree
    /// dump of the Priority dialog to the log (control type, class,
    /// AutomationId, supported patterns, name only when it is a short UI
    /// label ≤ 20 chars with no digits — otherwise name length), depth ≤ 6,
    /// ≤ 300 nodes." Raw view (same walker as the select strategy) so a
    /// hidden-from-control-view third-party control still shows up here for
    /// the next log to be conclusive about. Never throws.</summary>
    private static string DumpPriorityDialogRedacted(AutomationElement dialog)
    {
        const int maxNodes = 300;
        const int maxDepth = 6;
        var sb = new StringBuilder();
        var nodeCount = 0;

        try
        {
            var walker = dialog.Automation.TreeWalkerFactory.GetRawViewWalker();
            Walk(dialog, 0);

            void Walk(AutomationElement element, int depth)
            {
                if (nodeCount >= maxNodes || depth > maxDepth) return;
                nodeCount++;
                AppendRedactedNode(sb, element, depth);

                AutomationElement? child;
                try { child = walker.GetFirstChild(element); }
                catch { return; }
                while (child is not null && nodeCount < maxNodes)
                {
                    Walk(child, depth + 1);
                    try { child = walker.GetNextSibling(child); }
                    catch { break; }
                }
            }
        }
        catch (Exception ex)
        {
            sb.Append("<dump failed: ").Append(ex.GetType().Name).Append(": ").Append(ex.Message).Append('>');
        }

        return sb.ToString();
    }

    private static void AppendRedactedNode(StringBuilder sb, AutomationElement element, int depth)
    {
        string controlType = "?", className = "?", automationId = "?";
        try { controlType = element.ControlType.ToString(); } catch { }
        try { className = element.ClassName ?? "<null>"; } catch { }
        try { automationId = element.AutomationId ?? "<null>"; } catch { }

        sb.Append(' ', depth * 2)
          .Append(controlType)
          .Append(" class='").Append(className).Append('\'')
          .Append(" id='").Append(automationId).Append('\'')
          .Append(" patterns=[").Append(DescribeSupportedPatternsShort(element)).Append(']')
          .Append(' ').Append(PriorityDialogRedaction.Redact(SafeName(element)))
          .AppendLine();
    }

    private static string DescribeSupportedPatternsShort(AutomationElement element)
    {
        var supported = new List<string>();
        void Check(string label, Func<bool> isSupported)
        {
            try { if (isSupported()) supported.Add(label); }
            catch { /* omit — see UiaTreeDumper's own doc comment for this same caveat */ }
        }

        Check("Invoke", () => element.Patterns.Invoke.IsSupported);
        Check("Value", () => element.Patterns.Value.IsSupported);
        Check("SelectionItem", () => element.Patterns.SelectionItem.IsSupported);
        Check("Selection", () => element.Patterns.Selection.IsSupported);
        Check("ExpandCollapse", () => element.Patterns.ExpandCollapse.IsSupported);
        Check("LegacyIAccessible", () => element.Patterns.LegacyIAccessible.IsSupported);

        return supported.Count == 0 ? "none" : string.Join(",", supported);
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
    /// ResolvePriorityDialog, the same layered-strategy logic a normally
    /// recognized Priority dialog gets — see class doc comment's ROUND 4
    /// section) or "Scan"+"Hard Copy"
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
        HashSet<IntPtr> loggedIgnoredHandles, ref int priorityAttempt, bool mainWindowEnabled, Action<string> log)
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
                // timeout fix, and ROUND 3's ThemeManagerNotification/
                // WindowsForms10.Window.0 fix): a transient window (an
                // autocomplete dropdown, tooltip, tool/no-activate window,
                // WinForms' own invisible ThemeManagerNotification, or any
                // other untitled+invisible/zero-area/disabled window) is
                // NEVER a pre-entry dialog — it must not be ESC'd (that
                // likely cancels the field/form underneath, exactly how
                // both the 18:53 Auto-Suggest run and this round's
                // Priority-loop run happened) or counted against
                // maxAttemptsPerWindow. Logged once per handle so it's
                // visible in app.log without spamming every ~250ms tick.
                if (DialogClassifier.IsTransientWindow(info))
                {
                    if (loggedIgnoredHandles.Add(handle))
                    {
                        log($"[{Name}] Ignoring transient window class '{info.ClassName}' — {WindowInfoDiagnostics.DescribeNoPhiWithDecision(info, "ignored-nonblocking")}.");
                    }
                    continue;
                }

                var title = info.Title;

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

                attempts.TryGetValue(handle, out var count);

                if (kind == DialogKind.Priority)
                {
                    if (count >= maxAttemptsPerWindow) continue;
                    attempts[handle] = count + 1;
                    priorityAttempt++;
                    log($"[{Name}] Unrecognized top-level window \"{screenNameOnly}\" contains \"Priority\" — treating it as the Priority dialog " +
                        $"(pass {priorityAttempt}). {WindowInfoDiagnostics.DescribeNoPhiWithDecision(info, "handled-known")}.");
                    // ResolvePriorityDialog can throw PriorityDialogUnresolvedException
                    // (every strategy exhausted, dialog still open) — deliberately
                    // NOT caught by this method's own best-effort catch-all below,
                    // which would otherwise swallow it and return null instead of
                    // letting ExecuteAsync fail the step loud. See that catch block.
                    ResolvePriorityDialog(window, mainProcessId, log);
                    return PreEntryDialogTitles.Priority;
                }

                if (kind == DialogKind.ScanHardCopy)
                {
                    if (count >= maxAttemptsPerWindow) continue;
                    attempts[handle] = count + 1;
                    log($"[{Name}] Unrecognized top-level window \"{screenNameOnly}\" contains \"Scan\"/\"Hard Copy\" — dismissing. {WindowInfoDiagnostics.DescribeNoPhiWithDecision(info, "handled-known")}.");
                    if (TryDismiss(window)) return PreEntryDialogTitles.ScanHardCopy;
                    continue;
                }

                if (kind == DialogKind.PatientOnCycleFill)
                {
                    if (count >= maxAttemptsPerWindow) continue;
                    attempts[handle] = count + 1;
                    log($"[{Name}] Unrecognized top-level window \"{screenNameOnly}\" contains \"Cycle Fill\" — dismissing. {WindowInfoDiagnostics.DescribeNoPhiWithDecision(info, "handled-known")}.");
                    if (TryDismiss(window)) return PreEntryDialogTitles.PatientOnCycleFill;
                    continue;
                }

                // V-T41 ROUND 3: kind == Unknown — only Escape a window
                // POSITIVELY identified as a modal blocking dialog (see
                // DialogClassifier.IsConfirmedBlockingModal's own doc
                // comment). This is the fix for the exact bug in this
                // round's log: blind-ESCing whatever unrecognized window
                // was left over cancelled the New Rx flow itself.
                if (!DialogClassifier.IsConfirmedBlockingModal(info, mainHandle, mainWindowEnabled))
                {
                    if (loggedIgnoredHandles.Add(handle))
                    {
                        log($"[{Name}] Ignoring unrecognized non-modal window (main window still enabled, or this window isn't its owned popup) — {WindowInfoDiagnostics.DescribeNoPhiWithDecision(info, "ignored-nonblocking")}.");
                    }
                    continue;
                }

                if (count >= maxAttemptsPerWindow) continue;
                attempts[handle] = count + 1;
                log($"[{Name}] Unrecognized pre-entry window \"{screenNameOnly}\" (class '{info.ClassName}') confirmed as a blocking modal (main window disabled) — pressing Escape once. {WindowInfoDiagnostics.DescribeNoPhiWithDecision(info, "escaped-unknown-modal")}.");
                if (TryDismiss(window)) return title;
            }
        }
        catch (PriorityDialogUnresolvedException)
        {
            // V-T41 ROUND 4: must propagate to ExecuteAsync's own dedicated
            // catch — this is a deliberate, definitive "give up, tell the
            // user" failure, not a transient scan hiccup the generic catch
            // below is for.
            throw;
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
