namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;

/// <summary>
/// V-... 2026-09-10 (Will, 2026-09-09/10: desktop data entry "made it
/// through to quantity (slowly) and stopped at quantity (not entered)" —
/// every vaccine row currently has a blank Quantity/Directions on file,
/// and the old InputQuantityStep/InputDirectionsStep silently skipped
/// typing anything when that was blank rather than asking staff for it).
/// Which button the user picked on the resulting blank-value prompt (see
/// PioneerEntryStepContext.RequestTextPrompt / Views/TextEntryPromptWindow).
/// Skip only ever applies to Directions — InputQuantityStep's own prompt
/// never shows a Skip button, since typing SOME quantity is required for
/// PioneerRx's Add New Rx quantity field to make sense at all, unlike
/// directions/SIG, which some workflows fill in later.
/// </summary>
public enum TextPromptAction
{
    Continue,
    Skip,
    Cancel,
}

/// <summary>
/// Outcome of a blank-Quantity/blank-Directions prompt. Value is only
/// meaningful when Action is Continue (empty string otherwise) —
/// TextEntryPromptWindow itself refuses to return Continue with a blank
/// textbox (see that class's TryContinue), so a step never has to
/// re-validate "was Continue somehow returned with nothing typed."
/// </summary>
public readonly record struct TextPromptResult(TextPromptAction Action, string Value)
{
    public static TextPromptResult Cancelled { get; } = new(TextPromptAction.Cancel, "");
    public static TextPromptResult Skipped { get; } = new(TextPromptAction.Skip, "");
    public static TextPromptResult Continued(string value) => new(TextPromptAction.Continue, value);
}
