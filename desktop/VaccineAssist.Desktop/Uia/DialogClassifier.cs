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

    /// <summary>
    /// V-T41 (Will's run tonight, 2026-09-13 18:53): "Start Add New Rx (F3)
    /// and dismiss pre-entry dialogs" timed out (0x80131505) — app.log
    /// showed it repeatedly finding a Pioneer-owned top-level window with
    /// an EMPTY TITLE and window class 'Auto-Suggest Dropdown' (Pioneer's
    /// own autocomplete popup for an Add New Rx form field), treating it as
    /// an unrecognized pre-entry dialog, and pressing Escape on it every
    /// ~7s — which likely also cancelled the field/form underneath, so the
    /// popup (or the retry loop) kept coming back until the step's overall
    /// budget ran out. These window classes are NOT pre-entry dialogs: an
    /// autocomplete/combo dropdown, a tooltip, or any other transient popup
    /// shell never needs (or survives) an Escape from this step — it should
    /// simply be ignored so the scan can keep looking for the real "Add New
    /// Rx" screen underneath it. See
    /// SendF3AndDismissPreEntryDialogsStep.TryDismissNextStrayPioneerWindow
    /// and HasBlockingPioneerWindow, both of which skip any window this
    /// returns true for (never ESC it, never treat it as a blocking modal)
    /// instead of running it through Classify above.
    /// </summary>
    public static bool IsTransientWindowClass(string? windowClass)
    {
        if (string.IsNullOrEmpty(windowClass)) return false;

        foreach (var exact in TransientExactWindowClasses)
        {
            if (string.Equals(windowClass, exact, StringComparison.OrdinalIgnoreCase)) return true;
        }
        foreach (var fragment in TransientWindowClassFragments)
        {
            if (windowClass.Contains(fragment, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    /// <summary>Window classes known to be transient popup shells rather
    /// than dialogs, matched by EXACT (case-insensitive) name — kept
    /// alongside <see cref="TransientWindowClassFragments"/> below for
    /// classes ('DropDown', 'ComboLBox') that don't contain any of those
    /// broader fragments.</summary>
    private static readonly string[] TransientExactWindowClasses =
    {
        "Auto-Suggest Dropdown",
        "tooltips_class32",
        "Xaml_WindowedPopupClass",
        "DropDown",
        "ComboLBox",
    };

    /// <summary>Case-insensitive substrings that mark a window class as a
    /// transient popup regardless of exact spelling/casing — covers
    /// 'Auto-Suggest Dropdown' (via "Auto-Suggest"), 'tooltips_class32'
    /// (via "Tooltip"), and 'Xaml_WindowedPopupClass' (via "Popup") in
    /// addition to any future Pioneer popup class following the same
    /// naming pattern.</summary>
    private static readonly string[] TransientWindowClassFragments =
    {
        "Popup",
        "Tooltip",
        "AutoSuggest",
        "Auto-Suggest",
    };

    /// <summary>
    /// V-T41 companion to <see cref="IsTransientWindowClass"/> — true for a
    /// window that should be excluded from pre-entry dialog handling
    /// entirely: either its Win32 class matches a known transient-popup
    /// shape, OR it has an empty title and isn't itself a real dialog frame
    /// (WS_DLGFRAME) — the shape of an unowned, untitled transient window
    /// whose class this list doesn't yet happen to name. A real pre-entry
    /// dialog (Priority/Scan Hard Copy/Patient on Cycle Fill) always
    /// carries a title, so this second check costs nothing against them.
    /// Pure — only reads `info`'s own fields, no UIA/Win32 call of its
    /// own.
    /// </summary>
    public static bool IsTransientWindow(WindowInfo info)
    {
        if (IsTransientWindowClass(info.ClassName)) return true;
        if (string.IsNullOrEmpty(info.Title) && !info.IsDialogFrameStyle) return true;
        return false;
    }
}
