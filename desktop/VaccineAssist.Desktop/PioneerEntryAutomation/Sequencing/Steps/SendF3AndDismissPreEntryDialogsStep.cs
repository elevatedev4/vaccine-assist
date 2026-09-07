using System;
using System.Collections.Generic;
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
/// SEQUENCE: (1) send F3 to the attached window: (2) wait — with its own
/// short, independent timeout — for a window titled like "Priority" to
/// appear and ESC it if it does; (3) same for "Scan Hard Copy"; in
/// WHATEVER ORDER they actually appear (each waited for independently, not
/// assumed first/second); (4) re-attach to whatever PioneerRx window is
/// now active (PioneerRxTitles.cs's own doc comment: the window title
/// stays "Add New Rx" while one of these dialogs is up, then resolves to
/// "Add New Rx - &lt;patient&gt; - ..." once the patient context loads) and
/// overwrite context.AttachedWindow with it — the reference
/// FocusPioneerWindowStep captured (the Rx Profile window) is stale for
/// every step after this one.
///
/// TIME-BOXED, NOT BLOCKING: Will's brief explicitly allows for these
/// dialogs to be "configured off on some machines" — each wait uses its
/// own PerDialogTimeout and, on timeout, logs a warning and moves on
/// rather than failing the whole entry or hanging indefinitely.
///
/// NOT CONFIRMED against a live UIA dump — see PreEntryDialogTitles.cs's
/// own doc comment for exactly what's unconfirmed and why. This step's
/// pure decision logic (dry-run description, guard clauses, title
/// matching via PreEntryDialogTitles.Matches) is covered by
/// SendF3AndDismissPreEntryDialogsStepTests.cs; the live FlaUI/UIA calls
/// below (like every other step's live branch in this sequence) can only
/// be proven against a real Pioneer install on Windows.
/// </summary>
public sealed class SendF3AndDismissPreEntryDialogsStep : IPioneerEntryStep
{
    public static readonly TimeSpan PerDialogTimeout = TimeSpan.FromSeconds(4);
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(200);

    public string Name => "Start Add New Rx (F3) and dismiss pre-entry dialogs";

    public async Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
    {
        if (context.DryRun)
        {
            return new PioneerEntryStepResult(Name, Success: true, DryRun: true,
                "Would press F3 from the Rx Profile, then ESC through the \"Priority\" and \"Scan Hard Copy\" " +
                "dialogs if either appears (no PioneerRx call made).");
        }

        if (context.AttachedWindow is null)
        {
            return new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                "No PioneerRx window attached — FocusPioneerWindowStep must run (and succeed) before this step.");
        }

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

        var warnings = new List<string>();
        foreach (var dialogTitle in PreEntryDialogTitles.All)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var dismissed = await TryDismissDialogAsync(dialogTitle, cancellationToken);
            if (!dismissed)
            {
                warnings.Add(
                    $"\"{dialogTitle}\" dialog did not appear within {PerDialogTimeout.TotalSeconds:0}s — " +
                    "continuing (this dialog may be configured off on this machine, or its title doesn't match PreEntryDialogTitles yet).");
            }
        }

        // The window PioneerRx now shows is "Add New Rx" (see
        // PioneerRxTitles.cs's own doc comment) — re-attach so every step
        // after this one targets IT, not the stale Rx Profile reference
        // FocusPioneerWindowStep captured.
        AutomationElement? addNewRxWindow;
        try
        {
            addNewRxWindow = PioneerRxAttachment.TryAttach();
        }
        catch (Exception ex)
        {
            return new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                $"F3 was sent, but re-attaching to the resulting \"Add New Rx\" window failed: {ex.Message}");
        }

        if (addNewRxWindow is null)
        {
            var reason = "F3 was sent, but couldn't re-attach to the resulting \"Add New Rx\" window.";
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

    /// <summary>Polls (PollInterval) for a top-level window whose title
    /// contains dialogTitleSubstring until PerDialogTimeout elapses, ESCs
    /// it the moment it's found, and returns whether one was found/dismissed
    /// at all. Never throws — a UIA session failure here is treated the
    /// same as "dialog not found yet," matching PioneerRxAttachment.TryAttach's
    /// own posture.</summary>
    private static async Task<bool> TryDismissDialogAsync(string dialogTitleSubstring, CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow + PerDialogTimeout;
        do
        {
            var dialog = FindTopLevelWindowByTitle(dialogTitleSubstring);
            if (dialog is not null)
            {
                try
                {
                    dialog.FocusNative();
                    Keyboard.Type(VirtualKeyShort.ESCAPE);
                }
                catch
                {
                    // Found it but couldn't dismiss it — report as
                    // not-dismissed rather than throwing out of the step.
                    return false;
                }
                return true;
            }

            await Task.Delay(PollInterval, cancellationToken);
        } while (DateTime.UtcNow < deadline);

        return false;
    }

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
}
