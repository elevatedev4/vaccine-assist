using System;
using System.Collections.Generic;

namespace VaccineAssist.Desktop.Uia;

/// <summary>
/// PURE (no UIA/FlaUI/Win32 dependency of its own — takes plain WindowInfo
/// values) selection logic for "which top-level windows are real dialog
/// candidates for the currently attached PioneerRx main window."
///
/// V-... 2026-09-14 (Will, verbatim): "The app is not recognizing the
/// Pioneer windows that pop up and is instead trying to stay focused and
/// work in the Pioneer main window. Pioneer will not let you do that
/// until you address the popups we've discussed (priority, cycle fill,
/// etc)." The enumeration itself (union of a UIA desktop scan and a raw
/// Win32 EnumWindows/EnumThreadWindows walk — see
/// Win32WindowEnumerator's own doc comment and
/// PioneerWindowInventory.EnumerateAllWindows) is what actually fixes
/// "not recognizing the Pioneer windows that pop up"; this class is the
/// second half — deciding, from that raw union, which windows are
/// legitimate dialog candidates versus noise:
///   - belongs to the SAME process as the attached main window
///     (`mainProcessId`) — a stray window from an unrelated PioneerRx
///     instance, or any other process entirely, is never a candidate;
///   - is NOT the main window itself (`mainHwnd`) — the bug this class
///     exists to prevent a REGRESSION of is the automation typing into
///     the main window while a modal sits on top of it, so the main
///     window must never come back out of Select() as something to be
///     dismissed/classified as a dialog.
///
/// Deliberately does NOT require OwnerHandle == mainHwnd or a
/// WS_POPUP/WS_DLGFRAME style bit to be set — Pioneer's Priority/Cycle
/// Fill/Scan Hard Copy prompts are unconfirmed against a live UIA dump
/// (see PreEntryDialogTitles's own doc comment) and may not actually set
/// an explicit Win32 owner on themselves; requiring one would risk
/// silently re-introducing the exact "0 window(s) dismissed" bug this
/// class exists to fix. OwnerHandle/style are still carried on every
/// returned WindowInfo for the caller's own logging/diagnostics and any
/// future tightening.
/// </summary>
public static class PioneerDialogCandidates
{
    public static IReadOnlyList<WindowInfo> Select(IEnumerable<WindowInfo> windows, int mainProcessId, IntPtr mainHwnd)
    {
        var seen = new HashSet<IntPtr>();
        var result = new List<WindowInfo>();
        foreach (var window in windows)
        {
            if (window.Handle == IntPtr.Zero) continue;
            if (window.Handle == mainHwnd) continue;
            if (window.ProcessId != mainProcessId) continue;
            if (!seen.Add(window.Handle)) continue; // de-dup (UIA and Win32 may both report the same handle)
            result.Add(window);
        }
        return result;
    }
}
