using System;

namespace VaccineAssist.Desktop.Uia;

/// <summary>
/// Case-insensitive "does this UIA element's Name represent the target
/// Priority value" check, used by
/// SendF3AndDismissPreEntryDialogsStep.TrySelectPriorityValue when scanning
/// a ComboBox/ListBox/DataGrid's items for the one matching
/// Settings.AppSettings.PriorityValue (default "Vaccine") — Will,
/// 2026-09-13: "It needs to set the priority to Vaccine when that window
/// comes up." Contains/case-insensitive (not exact-match), same posture as
/// PreEntryDialogTitles.Matches, so a close item label like "Vaccine
/// Administration" or "VACCINE" still matches. Pure (no UIA dependency of
/// its own) so it's directly unit-testable — see
/// SendF3AndDismissPreEntryDialogsStepTests.cs.
/// </summary>
public static class PriorityValueMatcher
{
    public static bool Matches(string? elementName, string targetValue) =>
        !string.IsNullOrEmpty(elementName) &&
        !string.IsNullOrEmpty(targetValue) &&
        elementName.Contains(targetValue, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// V-T41 ROUND 4 (Will's 2026-09-21 brief, point 2): the raw-view UIA
    /// select strategy and the keyboard type-ahead strategy both need
    /// STARTS-WITH semantics specifically ("a ListItem whose name starts
    /// with 'Vaccine'" / "verify ... starts with 'Vaccine'") rather than
    /// Matches' broader Contains — a combo item literally named "Vaccine"
    /// or "Vaccine Administration" should match, matching what a type-ahead
    /// "V" keystroke would actually land the selection on; an unrelated
    /// item that only mentions the word partway through its label should
    /// not. Leading whitespace is trimmed first since some WinForms list
    /// items pad their display text. Pure — no UIA dependency.
    /// </summary>
    public static bool StartsWith(string? elementName, string targetValue) =>
        !string.IsNullOrEmpty(elementName) &&
        !string.IsNullOrEmpty(targetValue) &&
        elementName.TrimStart().StartsWith(targetValue, StringComparison.OrdinalIgnoreCase);
}
