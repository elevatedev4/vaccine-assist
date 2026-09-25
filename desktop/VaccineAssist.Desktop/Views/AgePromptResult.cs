namespace VaccineAssist.Desktop.Views;

/// <summary>
/// Outcome of the Ctrl+Keypad 2 age prompt (AgePromptWindow; originally
/// Ctrl+Keypad 4, re-keyed same day — see AgePromptInput's doc comment)
/// — mirrors
/// TextPromptResult's shape (see
/// PioneerEntryAutomation/Sequencing/TextPromptResult.cs). Years is only
/// meaningful when Confirmed is true; AgePromptWindow itself refuses to
/// return Continued unless AgePromptInput.TryParse accepted the current
/// text (see AgePromptWindow.TryContinue), so a caller never has to
/// re-validate "was Continued somehow returned with an invalid age."
///
/// 2026-09-25 round 2: Months dropped — see AgePromptInput's doc comment.
/// </summary>
public readonly record struct AgePromptResult(bool Confirmed, int Years)
{
    public static AgePromptResult Cancelled { get; } = new(false, 0);

    public static AgePromptResult Continued(int years) => new(true, years);
}
