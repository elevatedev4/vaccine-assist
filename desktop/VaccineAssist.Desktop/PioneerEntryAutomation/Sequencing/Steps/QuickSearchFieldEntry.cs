using System;
using System.Threading;
using System.Threading.Tasks;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Input;
using FlaUI.Core.WindowsAPI;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// Shared "type a value into a PioneerRx quick-search Edit field, then
/// press ENTER N times" mechanism used by SelectPrescriberStep (physician
/// alternate ID, ENTER twice) and InputVaccineCodeStep (drug NDC, ENTER
/// twice) — both fields are the same shape in the live UIA dumps
/// (Edit control, Value pattern only, no separate popup/dialog appears
/// when the search resolves — confirmed against the "Add New Rx"
/// progressive-state dumps, 2026-09-05: uxPrescriberQuickSearch and
/// uxPrescribedItemQuickSearch both went from blank to a resolved
/// value with no new top-level window appearing in between).
///
/// SetValue (UIA ValuePattern) sets the text directly — it does NOT, by
/// itself, give the control real OS keyboard focus, so the ENTER
/// keystrokes below (real synthetic input, FlaUI.Core.Input.Keyboard —
/// there is no UIA "InvokeSearch" pattern PioneerRx exposes for this) would
/// land wherever focus already was without an explicit focus call first.
/// FocusNative() (not the plain UIA Focus()) is used deliberately: FlaUI's
/// own guidance is that legacy UI stacks — every control in these dumps is
/// a WindowsForms10.* class — don't reliably respond to the UIA-level
/// SetFocus() request FlaUI.Focus() sends, and PioneerRx's editable
/// quick-search fields are exactly that kind of control.
/// </summary>
internal static class QuickSearchFieldEntry
{
    /// <summary>Poll interval between retries of a recoverable (timed-out)
    /// SetValue/FocusNative/ENTER attempt — see V-T28's AutoWatchRetry.
    /// Same 200ms shape as SendF3AndDismissPreEntryDialogsStep.PollInterval;
    /// not shared with it (this class has no other relationship to that
    /// step beyond both living on the entry-sequence path).</summary>
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(200);

    public readonly record struct Outcome(bool Success, string Message);

    /// <summary>
    /// V-T28 (Will, 2026-09-09): "Made it to the start of data entry into
    /// Pioneer, then error: Unexpected error during auto-watch: Operation
    /// timed out. (0x80131505)" — this is the single shared method every
    /// live field-typing step (SelectPrescriberStep, InputVaccineCodeStep,
    /// InputLotAndExpirationStep x2, InputQuantityStep, InputDirectionsStep)
    /// calls, and previously made exactly ONE attempt at
    /// SetValue/FocusNative/ENTER with no retry — a single transient
    /// "PioneerRx didn't respond to this one UIA call in time" failed
    /// whichever step was typing at that moment (and, since
    /// PioneerEntrySequenceRunner stops at the first failed step, the whole
    /// entry) immediately. Now retries a recoverable failure (see
    /// AutoWatchErrorClassifier) for up to AutoWatchRetry.DefaultOverallBudget
    /// (60s default) before giving up — `log`, when given, is called once
    /// per retry (never on the final give-up) so the step log/AppFileLog
    /// shows "still waiting" progress instead of the popup just sitting
    /// there with no explanation for up to a minute.
    ///
    /// Renamed from the old synchronous TypeAndConfirm (Async suffix,
    /// matching every other awaited method on this path) — the "field not
    /// found" / "Value pattern not supported" checks stay single-shot
    /// (those are never transient — retrying "this control simply isn't a
    /// text field" for 60s would just burn the whole budget on a failure
    /// that was never going to un-happen), only the actual
    /// SetValue/FocusNative/ENTER attempt is retried.
    /// </summary>
    public static async Task<Outcome> TypeAndConfirmAsync(
        AutomationElement window, string automationId, string fieldLabel, string value, int enterPresses,
        Action<string>? log = null, CancellationToken cancellationToken = default)
    {
        AutomationElement? field;
        try
        {
            field = window.FindFirstDescendant(cf => cf.ByAutomationId(automationId));
        }
        catch (Exception ex)
        {
            return new Outcome(false, $"Couldn't search for the {fieldLabel} field (AutomationId '{automationId}'): {ex.Message}");
        }

        if (field is null)
        {
            return new Outcome(false,
                $"Couldn't find the {fieldLabel} field (AutomationId '{automationId}') on the attached PioneerRx window — " +
                "confirm the patient's Rx Profile or an in-progress Add New Rx is the active screen.");
        }

        try
        {
            if (!field.Patterns.Value.IsSupported)
            {
                return new Outcome(false, $"The {fieldLabel} field (AutomationId '{automationId}') doesn't support the UIA Value pattern — can't type into it.");
            }
        }
        catch (Exception ex)
        {
            return new Outcome(false, $"Couldn't check the {fieldLabel} field's Value pattern support (AutomationId '{automationId}'): {ex.Message}");
        }

        try
        {
            await AutoWatchRetry.RunAsync(
                attempt: () =>
                {
                    field.Patterns.Value.Pattern.SetValue(value);
                    field.FocusNative();
                    for (var i = 0; i < enterPresses; i++)
                    {
                        Keyboard.Type(VirtualKeyShort.RETURN);
                    }
                    return true;
                },
                overallBudget: AutoWatchRetry.DefaultOverallBudget,
                now: () => DateTime.UtcNow,
                onRecoverableWait: async (ex, elapsed) =>
                {
                    log?.Invoke($"Still waiting to enter the {fieldLabel} (AutomationId '{automationId}') after " +
                        $"{elapsed.TotalSeconds:0.0}s — {ex.GetType().Name}: {ex.Message}. PioneerRx may be busy; retrying...");
                    await Task.Delay(PollInterval, cancellationToken);
                },
                cancellationToken: cancellationToken);
        }
        catch (Exception ex)
        {
            return new Outcome(false, $"Failed to enter the {fieldLabel} (AutomationId '{automationId}'): {ex.Message}");
        }

        return new Outcome(true, $"Entered {fieldLabel} \"{value}\" and pressed ENTER {enterPresses} time(s).");
    }
}
