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
}
