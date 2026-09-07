using System;

namespace VaccineAssist.Desktop.Uia;

/// <summary>
/// Window-title substrings for the two modal sub-dialogs that appear
/// between pressing F3 on a patient's Rx Profile and reaching the real
/// "Add New Rx" screen — Will's verbatim brief (2026-09-07): "So from that
/// profile screen, push F3, then two windows will open that have to be
/// escaped from, Priority, and Scan hard copy. Keep in mind, all of this
/// is in the original macro I gave you."
///
/// NOT CONFIRMED against a live UIA dump (unlike PioneerRxTitles.cs's own
/// prefixes) — no dump of either dialog exists in this repo; that same
/// TODO.md doc comment DOES independently corroborate that a modal
/// sub-dialog appears in this spot ("Add New Rx" while a modal sub-dialog
/// like the priority/promise-time prompt is up"), but not its exact
/// title text. These two strings are built directly from Will's own
/// wording. Confirm the exact titles against a live UIA dump (the "Dump
/// Pioneer UIA tree" button, run WHILE one of these dialogs is showing —
/// see Uia/UiaTreeDumper.cs) and adjust here if they differ; matching is
/// deliberately Contains/case-insensitive (see Matches) so a close title
/// like "Select Priority" or "Scan Hard Copy Order" still matches.
/// </summary>
public static class PreEntryDialogTitles
{
    public const string Priority = "Priority";
    public const string ScanHardCopy = "Scan Hard Copy";

    /// <summary>Order doesn't matter to the caller — DismissPreEntryDialogsStep
    /// waits for each independently and dismisses whichever appears,
    /// "in whatever order they appear" per the brief.</summary>
    public static readonly string[] All = { Priority, ScanHardCopy };

    public static bool Matches(string windowTitle, string dialogTitleSubstring) =>
        windowTitle.Contains(dialogTitleSubstring, StringComparison.OrdinalIgnoreCase);
}
