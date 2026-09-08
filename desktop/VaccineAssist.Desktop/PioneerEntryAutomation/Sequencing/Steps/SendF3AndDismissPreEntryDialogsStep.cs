using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using FlaUI.Core.AutomationElements;
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
/// SEQUENCE: (1) send F3 to the attached window; (2) run
/// DismissPendingDialogsAsync against a SINGLE SHARED tick budget
/// (CombinedDialogsTimeout / PollInterval) to ESC whichever of
/// "Priority"/"Scan Hard Copy" shows up, in whatever order, rescanning
/// immediately after each dismissal; (3) re-attach to the resulting
/// "Add New Rx" window specifically (NOT just re-running
/// PioneerRxAttachment.TryAttach(), which could hand back the SAME stale
/// Rx Profile window — see the REVIEWER FIX note below) and overwrite
/// context.AttachedWindow with it.
///
/// REVIEWER FIX (request-changes round, 2026-09-07) — dialog polling: the
/// original version ran two INDEPENDENT waits, each with its own
/// per-dialog timeout, checking "Priority" to completion before ever
/// checking "Scan Hard Copy" at all. That's wrong two ways: (a) if
/// "Priority" never appears (configured off on this machine), the WHOLE
/// timeout burns before "Scan Hard Copy" — which may already be sitting
/// there — is even looked for; (b) if the two dialogs are SEQUENTIAL/modal
/// (the second only appears once the first is dismissed), a fixed
/// first-then-second order can miss "Scan Hard Copy" entirely if it
/// appears while the loop is still (uselessly) waiting out the rest of
/// "Priority"'s slice, or never appears if the dialogs come in the
/// opposite order to whatever's hardcoded. Fixed by DismissPendingDialogsAsync
/// below: a SINGLE shared budget, scanning for ANY pending title on every
/// tick and removing each the moment it's dismissed, rescanning
/// IMMEDIATELY (no wait) right after a dismissal — order-agnostic, and
/// correct for the sequential-appearance case since a dialog that only
/// appears once the first is gone is caught on the very next check, not
/// after waiting out an unrelated timer. Extracted as its own PUBLIC
/// static method (this repo has no InternalsVisibleTo wired up — same
/// "pure logic split out as a public static method for testability"
/// pattern as Uia/UiaTreeDumper.TruncateValue and
/// Uia/PioneerRxPresenceDecision) so xUnit can drive it with fake
/// tryDismissIfShowing/waitTick delegates instead of real UIA/wall-clock
/// waits — see SendF3AndDismissPreEntryDialogsStepTests.cs for the
/// either-order and sequential-appearance cases this specifically proves.
///
/// REVIEWER FIX (request-changes round, 2026-09-07) — re-attach target:
/// the original version called PioneerRxAttachment.TryAttach() again,
/// unchanged — but that method matches ANY PioneerRxTitles prefix
/// ("Rx Profile" AND "New Rx" both qualify) and returns the FIRST
/// candidate found with no ordering guarantee, so if the Rx Profile
/// window is still open behind Add New Rx (or the UIA desktop-children
/// enumeration order simply differs from expectation), the "re-attach"
/// could silently hand back the SAME stale Rx Profile window instead of
/// the new Add New Rx one — every field step after this one would then
/// search the wrong window and fail confusingly. Fixed by a dedicated,
/// narrower lookup (TryAttachToAddNewRxWindow below) used ONLY by this
/// step: title must specifically contain "New Rx" (matches both
/// "New Rx" and "Add New Rx" — the same prefix PioneerRxTitles.cs already
/// lists), and the window handle captured before F3 was sent
/// (previousHandle) is explicitly excluded. No process-name fallback here
/// (unlike PioneerRxAttachment) — if nothing distinct matches, this step
/// FAILS LOUD rather than silently continuing against a wrong/stale
/// window.
///
/// TIME-BOXED, NOT BLOCKING: Will's brief explicitly allows for these
/// dialogs to be "configured off on some machines" — on a shared-budget
/// timeout with dialogs still pending, this step logs a warning and moves
/// on rather than failing the whole entry or hanging indefinitely.
///
/// NOT CONFIRMED against a live UIA dump — see PreEntryDialogTitles.cs's
/// own doc comment for exactly what's unconfirmed and why. This step's
/// pure decision logic (dry-run description, guard clauses, title
/// matching via PreEntryDialogTitles.Matches, and the
/// DismissPendingDialogsAsync polling algorithm itself) is covered by
/// SendF3AndDismissPreEntryDialogsStepTests.cs; the live FlaUI/UIA calls
/// below (like every other step's live branch in this sequence) can only
/// be proven against a real Pioneer install on Windows.
/// </summary>
public sealed class SendF3AndDismissPreEntryDialogsStep : IPioneerEntryStep
{
    /// <summary>Shared budget for BOTH dialogs combined, not per-dialog —
    /// see the REVIEWER FIX note above for why a per-dialog timeout was
    /// wrong. Converted to a tick count (via PollInterval) for
    /// DismissPendingDialogsAsync, which is deadline-agnostic/pure — it
    /// counts consecutive empty ticks rather than reading the wall
    /// clock, so it's drivable by a test with no real waiting at all.</summary>
    public static readonly TimeSpan CombinedDialogsTimeout = TimeSpan.FromSeconds(8);
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

        var previousHandle = SafeNativeHandle(context.AttachedWindow);

        try
        {
            context.AttachedWindow.FocusNative();
            Keyboard.Type(VirtualKeyShort.F3);
        }
        catch (Exception ex)
        {
            return new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                $"Couldn't send F3 to the Rx Profile window: {ex.Message}");
        }

        var maxEmptyTicks = (int)Math.Ceiling(CombinedDialogsTimeout.TotalMilliseconds / PollInterval.TotalMilliseconds);
        IReadOnlySet<string> pending;
        try
        {
            pending = await DismissPendingDialogsAsync(
                PreEntryDialogTitles.All,
                maxEmptyTicks,
                TryDismissIfShowing,
                () => Task.Delay(PollInterval, cancellationToken),
                cancellationToken);
        }
        catch (Exception ex)
        {
            return new PioneerEntryStepResult(Name, Success: false, DryRun: false,
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

        // The window PioneerRx now shows is "Add New Rx" (see
        // PioneerRxTitles.cs's own doc comment) — re-attach to THAT window
        // specifically, not just any PioneerRxTitles-matching window (see
        // this class's own REVIEWER FIX note on why a plain
        // PioneerRxAttachment.TryAttach() re-run is unsafe here).
        AutomationElement? addNewRxWindow;
        try
        {
            addNewRxWindow = TryAttachToAddNewRxWindow(previousHandle);
        }
        catch (Exception ex)
        {
            return new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                $"F3 was sent, but re-attaching to the resulting \"Add New Rx\" window failed: {ex.Message}");
        }

        if (addNewRxWindow is null)
        {
            var reason = "F3 was sent, but couldn't find a distinct \"Add New Rx\" window to re-attach to " +
                "(failing loud rather than risking a silent re-attach to the stale Rx Profile window).";
            return new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                warnings.Count > 0 ? reason + " " + string.Join(" ", warnings) : reason);
        }

        context.AttachedWindow = addNewRxWindow;

        var message = "Sent F3 and dismissed any pre-entry dialogs.";
        if (warnings.Count > 0)
        {
            message += " " + string.Join(" ", warnings);
        }
        return new PioneerEntryStepResult(Name, Success: true, DryRun: false, message);
    }

    /// <summary>
    /// PURE polling algorithm (no UIA/FlaUI dependency of its own — see
    /// this class's own REVIEWER FIX note for why this was extracted).
    /// Repeatedly scans `titles` for whichever is CURRENTLY showing (via
    /// tryDismissIfShowing, which both checks AND dismisses in one call —
    /// so a caller never dismisses the same one twice) and removes each as
    /// it's dismissed, immediately trying again with no wait (a dismissal
    /// may reveal the next dialog right away — the sequential/modal case
    /// this whole rewrite exists for). Only waits (via waitTick) after a
    /// tick where NOTHING was dismissed, and gives up once
    /// maxEmptyTicks such empty ticks have passed in a row. Returns
    /// whatever's LEFT in the pending set (empty = everything got
    /// dismissed) — the caller turns a non-empty result into a warning,
    /// never a hard failure (Will's brief: dialogs may be "configured off
    /// on some machines").
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

    /// <summary>Finds a top-level window titled like titleSubstring and
    /// ESCs it, in one call, so DismissPendingDialogsAsync never has to
    /// find-then-separately-dismiss the same window twice. Returns false
    /// (never throws) both when nothing matches yet and when a match was
    /// found but couldn't be dismissed — either way, the caller just
    /// treats it as "not this tick" and keeps polling.</summary>
    private static bool TryDismissIfShowing(string titleSubstring)
    {
        var window = FindTopLevelWindowByTitle(titleSubstring);
        return window is not null && TryDismiss(window);
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

    /// <summary>Never throws — a UIA session failure here is treated the
    /// same as "not found yet," matching PioneerRxAttachment.TryAttach's
    /// own posture.</summary>
    private static AutomationElement? FindTopLevelWindowByTitle(string titleSubstring)
    {
        try
        {
            using var automation = new UIA3Automation();
            var desktop = automation.GetDesktop();
            foreach (var window in desktop.FindAllChildren())
            {
                string? name;
                try { name = window.Name; }
                catch { continue; }

                if (name is not null && PreEntryDialogTitles.Matches(name, titleSubstring))
                {
                    return window;
                }
            }
        }
        catch
        {
            // No live UIA session available — treated as "not found yet,"
            // same posture as PioneerRxAttachment.TryAttach.
        }
        return null;
    }

    /// <summary>Finds a top-level window titled like "Add New Rx"/"New Rx"
    /// (Contains "New Rx" covers both — the same prefix PioneerRxTitles.cs
    /// already lists) that is NOT the window identified by excludeHandle —
    /// see this class's own REVIEWER FIX note for why a plain
    /// PioneerRxAttachment.TryAttach() re-run isn't safe for this specific
    /// re-attach. Deliberately no process-name fallback (unlike
    /// PioneerRxAttachment) — returns null (never throws for an expected
    /// "not found" case) so the caller can fail loud instead of guessing.</summary>
    private static AutomationElement? TryAttachToAddNewRxWindow(IntPtr excludeHandle)
    {
        try
        {
            using var automation = new UIA3Automation();
            var desktop = automation.GetDesktop();
            foreach (var window in desktop.FindAllChildren())
            {
                string? name;
                try { name = window.Name; }
                catch { continue; }

                if (string.IsNullOrEmpty(name)) continue;
                if (!name.Contains("New Rx", StringComparison.OrdinalIgnoreCase)) continue;

                var handle = SafeNativeHandle(window);
                if (excludeHandle != IntPtr.Zero && handle == excludeHandle) continue;

                return window;
            }
        }
        catch
        {
            // Treated as "not found," same posture as PioneerRxAttachment.TryAttach.
        }
        return null;
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
