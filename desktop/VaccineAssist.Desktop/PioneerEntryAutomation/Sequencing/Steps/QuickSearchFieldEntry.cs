using System;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Input;

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
    public readonly record struct Outcome(bool Success, string Message);

    public static Outcome TypeAndConfirm(AutomationElement window, string automationId, string fieldLabel, string value, int enterPresses)
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

            field.Patterns.Value.Pattern.SetValue(value);
            field.FocusNative();
            for (var i = 0; i < enterPresses; i++)
            {
                Keyboard.Type(VirtualKeyShort.RETURN);
            }
        }
        catch (Exception ex)
        {
            return new Outcome(false, $"Failed to enter the {fieldLabel} (AutomationId '{automationId}'): {ex.Message}");
        }

        return new Outcome(true, $"Entered {fieldLabel} \"{value}\" and pressed ENTER {enterPresses} time(s).");
    }
}
