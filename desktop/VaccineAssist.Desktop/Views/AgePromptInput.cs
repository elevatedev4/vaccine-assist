namespace VaccineAssist.Desktop.Views;

/// <summary>
/// Pure parsing/validation for the Ctrl+Keypad 2 age prompt (originally
/// Ctrl+Keypad 4; re-keyed same day — Will's brief, 2026-09-25) — kept
/// separate from AgePromptWindow (a real WPF Window) so it's covered by
/// fast xUnit tests instead of only a manual
/// trace, same "pure half" split as Hotkeys/HotKeyMessage.cs (vs.
/// Hotkeys/GlobalHotKey.cs). Years mirrors DataEntryPopupViewModel's own
/// patient-age range (0-120, see its ContinueFromAgeAsync).
///
/// 2026-09-25 round 2 (Will, verbatim): "We don't vaccicne less than age
/// 3, so remove the months indicator." Months (0-23, for a finer
/// under-2 filter) is gone entirely — years-only from here on; 0 stays
/// allowed for consistency with the cloud filter even though it's no
/// longer expected in practice.
/// </summary>
public static class AgePromptInput
{
    public const int MinYears = 0;
    public const int MaxYears = 120;

    /// <summary>
    /// True (with the parsed <paramref name="years"/> out) only when
    /// yearsText is a valid 0-120 integer. False (years 0) for anything
    /// else — a blank/non-numeric years box or an out-of-range value.
    /// </summary>
    public static bool TryParse(string? yearsText, out int years)
    {
        years = 0;

        if (!int.TryParse((yearsText ?? string.Empty).Trim(), out var parsedYears) ||
            parsedYears < MinYears || parsedYears > MaxYears)
        {
            return false;
        }

        years = parsedYears;
        return true;
    }
}
