using System;

namespace VaccineAssist.Desktop.Uia;

/// <summary>The recognized shape of a pre-entry dialog candidate — see
/// DialogClassifier.Classify.</summary>
public enum DialogKind
{
    Priority,
    ScanHardCopy,
    PatientOnCycleFill,
    Unknown,
}

/// <summary>
/// PURE text-based classifier for a pre-entry dialog candidate window —
/// wraps PreEntryDialogTitles' existing Contains-style matchers
/// (ContainsPriority / ContainsScanAndHardCopy) plus a "Cycle Fill"
/// substring check into a single DialogKind result, so
/// SendF3AndDismissPreEntryDialogsStep's stray-window handling has ONE
/// classification call instead of separate if-checks repeated at each
/// call site (V-... 2026-09-14 popup-detection fix — see
/// PioneerDialogCandidates' own doc comment for the enumeration half of
/// that fix).
///
/// `text` is expected to be the window's title PLUS its visible
/// button/text control names concatenated (see
/// SendF3AndDismissPreEntryDialogsStep.BuildClassificationText) — the same
/// input shape ContainsPriority/ContainsScanAndHardCopy already expect.
/// Pure string logic, no UIA/Win32 dependency of its own.
/// </summary>
public static class DialogClassifier
{
    public static DialogKind Classify(string text)
    {
        if (string.IsNullOrEmpty(text)) return DialogKind.Unknown;
        if (PreEntryDialogTitles.ContainsPriority(text)) return DialogKind.Priority;
        if (PreEntryDialogTitles.ContainsScanAndHardCopy(text)) return DialogKind.ScanHardCopy;
        if (text.Contains("Cycle Fill", StringComparison.OrdinalIgnoreCase)) return DialogKind.PatientOnCycleFill;
        return DialogKind.Unknown;
    }
}
