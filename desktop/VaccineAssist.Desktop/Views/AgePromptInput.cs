namespace VaccineAssist.Desktop.Views;

/// <summary>
/// Pure parsing/validation for the Ctrl+Keypad 4 age prompt (Will's
/// brief, 2026-09-25) — kept separate from AgePromptWindow (a real WPF
/// Window) so it's covered by fast xUnit tests instead of only a manual
/// trace, same "pure half" split as Hotkeys/HotKeyMessage.cs (vs.
/// Hotkeys/GlobalHotKey.cs). Years mirrors DataEntryPopupViewModel's own
/// patient-age range (0-120, see its ContinueFromAgeAsync); Months is
/// optional — left blank for anyone 2 or older — and, when given, must be
/// a plausible 0-23.
/// </summary>
public static class AgePromptInput
{
    public const int MinYears = 0;
    public const int MaxYears = 120;
    public const int MinMonths = 0;
    public const int MaxMonths = 23;

    /// <summary>
    /// True (with the parsed <paramref name="years"/> and optional
    /// <paramref name="months"/> out) only when yearsText is a valid
    /// 0-120 integer and monthsText is either blank/whitespace-only or a
    /// valid 0-23 integer. False (years 0, months null) for anything
    /// else — a blank/non-numeric years box, an out-of-range value in
    /// either box, or a non-numeric months box that isn't just blank.
    /// </summary>
    public static bool TryParse(string? yearsText, string? monthsText, out int years, out int? months)
    {
        years = 0;
        months = null;

        if (!int.TryParse((yearsText ?? string.Empty).Trim(), out var parsedYears) ||
            parsedYears < MinYears || parsedYears > MaxYears)
        {
            return false;
        }

        var trimmedMonths = (monthsText ?? string.Empty).Trim();
        if (trimmedMonths.Length > 0)
        {
            if (!int.TryParse(trimmedMonths, out var parsedMonths) ||
                parsedMonths < MinMonths || parsedMonths > MaxMonths)
            {
                return false;
            }

            months = parsedMonths;
        }

        years = parsedYears;
        return true;
    }
}
