namespace VaccineAssist.Desktop.Views;

/// <summary>
/// Outcome of the Ctrl+Keypad 4 age prompt (AgePromptWindow) — mirrors
/// TextPromptResult's shape (see
/// PioneerEntryAutomation/Sequencing/TextPromptResult.cs). Years/Months
/// are only meaningful when Confirmed is true; AgePromptWindow itself
/// refuses to return Continued unless AgePromptInput.TryParse accepted
/// the current text (see AgePromptWindow.TryContinue), so a caller never
/// has to re-validate "was Continued somehow returned with an invalid
/// age."
/// </summary>
public readonly record struct AgePromptResult(bool Confirmed, int Years, int? Months)
{
    public static AgePromptResult Cancelled { get; } = new(false, 0, null);

    public static AgePromptResult Continued(int years, int? months) => new(true, years, months);
}
