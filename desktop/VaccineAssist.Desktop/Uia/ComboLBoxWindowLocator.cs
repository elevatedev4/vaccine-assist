using System;
using System.Collections.Generic;

namespace VaccineAssist.Desktop.Uia;

/// <summary>
/// V-T41 ROUND 4 (Will's 2026-09-21 brief, point 3): the 2026-09-21 log
/// showed "FAILED to find a selectable 'Vaccine' item via UIA (no matching
/// ComboBox/ListBox/DataGrid item)" on every attempt, alongside dozens of
/// "Ignoring transient window class 'ComboLBox'" lines during the SAME
/// step. Standard Win32 combo box behaviour: when a combo's drop-down list
/// is expanded, the list itself is rendered as a SEPARATE TOP-LEVEL window
/// (class 'ComboLBox'), not a descendant of the dialog/combo that owns
/// it — so a UIA scan confined to the Priority dialog's own subtree (or
/// even the combo control's own subtree) can never see the "Vaccine" list
/// item, no matter how the search is written, because it genuinely isn't
/// there. This is a PURE (WindowInfo only, no UIA/Win32 call of its own)
/// filter for "which currently-enumerated top-level window is that
/// same-process ComboLBox popup" — used by
/// SendF3AndDismissPreEntryDialogsStep's UIA select strategy right after
/// expanding a ComboBox, when the combo's own subtree didn't contain a
/// match. Kept separate from DialogClassifier.IsTransientWindowClass
/// (which already, correctly, treats 'ComboLBox' as never-Escape/never-
/// blocking) — that fix stays exactly as-is; this class is the OTHER half:
/// actively USING that same window as a positive search target instead of
/// only ever ignoring it.
/// </summary>
public static class ComboLBoxWindowLocator
{
    private const string ComboLBoxClassName = "ComboLBox";

    /// <summary>Returns the first same-process top-level window classed
    /// 'ComboLBox' (in practice there is at most one open at a time — a
    /// single combo's drop-down), or null if none is currently
    /// enumerated.</summary>
    public static WindowInfo? Find(IEnumerable<WindowInfo> windows, int mainProcessId)
    {
        foreach (var window in windows)
        {
            if (window.ProcessId == mainProcessId &&
                string.Equals(window.ClassName, ComboLBoxClassName, StringComparison.OrdinalIgnoreCase))
            {
                return window;
            }
        }
        return null;
    }
}
