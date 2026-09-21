using System;

namespace VaccineAssist.Desktop.Uia;

/// <summary>
/// V-T41 ROUND 3 (Will's 2026-09-21 brief, point 4): "Log for every window
/// considered: class, title length, visible, enabled, rect size,
/// style/exstyle hex, owner hwnd, and the decision ... so the next log is
/// conclusive." Pure, no UIA/Win32 dependency of its own (reads only
/// WindowInfo's own fields).
///
/// NO PHI: deliberately logs the window title's LENGTH, never its text — a
/// PioneerRx window title can carry a patient name (see
/// SendF3AndDismissPreEntryDialogsStep.DescribeAnyPioneerWindowForLog and
/// PioneerWindowInventory.SafeTitle, which truncate a title before its
/// first " - " for the same reason; this formatter is stricter still,
/// since a title with no " - " at all — e.g. "Smith, John" — would still
/// leak through that truncation).
/// </summary>
public static class WindowInfoDiagnostics
{
    public static string DescribeNoPhi(WindowInfo info) =>
        $"class='{info.ClassName}' titleLen={info.Title?.Length ?? 0} visible={info.IsVisible} " +
        $"enabled={info.IsEnabled} size={info.Width}x{info.Height} exStyle=0x{(info.ExStyle & 0xFFFFFFFFL):X} " +
        $"style=0x{(info.Style & 0xFFFFFFFFL):X} owner=0x{info.OwnerHandle.ToInt64():X}";

    /// <summary>`decision` is one of "ignored-nonblocking" (transient, or
    /// unrecognized-but-not-a-confirmed-modal — never Escaped),
    /// "handled-known" (a recognized dialog — Priority select/confirm, or
    /// Scan Hard Copy/Patient on Cycle Fill Escape), or
    /// "escaped-unknown-modal" (unrecognized but positively confirmed as a
    /// blocking modal via DialogClassifier.IsConfirmedBlockingModal —
    /// Escaped once).</summary>
    public static string DescribeNoPhiWithDecision(WindowInfo info, string decision) =>
        $"{DescribeNoPhi(info)} decision={decision}";
}
