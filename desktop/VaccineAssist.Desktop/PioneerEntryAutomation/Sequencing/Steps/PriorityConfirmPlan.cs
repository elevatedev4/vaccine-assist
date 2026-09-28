namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// V-T41 (Will's 2026-09-28 report): "It makes it to the priority screen
/// and enters 'Vaccine' as the priority, but fails to save it. Need to
/// push F12 after that, then continue." This is the PURE documentation
/// half of the fix — the fixed attempt order
/// <see cref="SendF3AndDismissPreEntryDialogsStep.TryConfirmDialog"/> tries
/// when confirming the "Priority" dialog, extracted so a regression (e.g.
/// F12 silently dropped back behind the button/Enter fallbacks) is caught
/// by a plain unit test rather than only discoverable live in Pioneer. No
/// UIA/Win32 dependency of its own — see PriorityConfirmPlanTests.cs.
/// </summary>
public enum PriorityConfirmStep
{
    F12,
    InvokeSaveButton,
    Enter,
    AltO,
}

public static class PriorityConfirmPlan
{
    public static readonly IReadOnlyList<PriorityConfirmStep> Order = new[]
    {
        PriorityConfirmStep.F12,
        PriorityConfirmStep.InvokeSaveButton,
        PriorityConfirmStep.Enter,
        PriorityConfirmStep.AltO,
    };
}
