using System;
using System.Collections.Generic;

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

    /// <summary>
    /// V-T41 ROUND 4 REVIEW FIX (non-blocking, safety reviewer): "exact
    /// 'Vaccine' match first, then starts-with" — an item literally named
    /// "Vaccine" (trimmed, case-insensitive) is a stronger signal than one
    /// that merely starts with it (e.g. "Vaccine Administration" or
    /// "Vaccines" would both satisfy StartsWith but not Exact). Pure — no
    /// UIA dependency.
    /// </summary>
    public static bool Exact(string? elementName, string targetValue) =>
        !string.IsNullOrEmpty(elementName) &&
        !string.IsNullOrEmpty(targetValue) &&
        string.Equals(elementName.Trim(), targetValue, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// PURE precedence orchestration used by
    /// SendF3AndDismissPreEntryDialogsStep.FindVaccineItem: scans
    /// `candidateNames` (in encounter order) for an Exact match FIRST,
    /// across the WHOLE list, before falling back to a second pass looking
    /// for any StartsWith match — so an exact "Vaccine" later in the list
    /// is always preferred over an earlier "Vaccine Administration," never
    /// the reverse. Returns the matched index, or -1 if neither pass finds
    /// anything. No UIA dependency — directly unit-testable with plain
    /// strings.
    /// </summary>
    public static int FindBestMatchIndex(IReadOnlyList<string?> candidateNames, string targetValue)
    {
        for (var i = 0; i < candidateNames.Count; i++)
        {
            if (Exact(candidateNames[i], targetValue)) return i;
        }
        for (var i = 0; i < candidateNames.Count; i++)
        {
            if (StartsWith(candidateNames[i], targetValue)) return i;
        }
        return -1;
    }
}
