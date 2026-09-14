using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace VaccineAssist.Desktop.Uia;

/// <summary>
/// Plain (no FlaUI/UIA dependency) description of one top-level Win32
/// window — Handle/Title/ProcessId plus OwnerHandle and the two style bits
/// (WS_POPUP, WS_DLGFRAME) PioneerDialogCandidates.Select and
/// SendF3AndDismissPreEntryDialogsStep's classification logic care about.
/// Deliberately UIA-free so it (and PioneerDialogCandidates.Select, which
/// consumes it) is directly unit-testable with plain values — no live
/// Windows session required.
/// </summary>
public readonly record struct WindowInfo(
    IntPtr Handle,
    string Title,
    int ProcessId,
    IntPtr OwnerHandle,
    bool IsPopupStyle,
    bool IsDialogFrameStyle);

/// <summary>
/// V-... 2026-09-14 (Will, verbatim): "The app is not recognizing the
/// Pioneer windows that pop up and is instead trying to stay focused and
/// work in the Pioneer main window. Pioneer will not let you do that
/// until you address the popups we've discussed (priority, cycle fill,
/// etc)." — after the 2026-09-13 night's readiness/classification fixes,
/// the combined pre-entry loop still logged "0 window(s) dismissed,
/// ready=True" while a Priority/Cycle Fill/Scan Hard Copy dialog was
/// demonstrably open. Every dialog-finding scan in this codebase up to
/// this point relied SOLELY on FlaUI/UIA3's
/// <c>Desktop.FindAllChildren()</c> walk, which asks UI Automation's own
/// cached/lazily-built provider tree what top-level windows exist right
/// now — a legacy WinForms owned dialog that UIA hasn't (yet, or ever)
/// registered a provider for simply never appears in that walk, no matter
/// how good the title-matching/classification logic downstream is. This
/// class is the fix: a raw Win32 <c>EnumWindows</c>/<c>EnumThreadWindows</c>
/// walk, which asks the OS's own top-level window list directly, with NO
/// dependency on UIA having cataloged anything. Used as a SECOND,
/// independent source of "what top-level windows exist" alongside the
/// existing UIA scan — see
/// PioneerWindowInventory.EnumerateAllWindows, which unions both sources
/// (deduped by HWND) before FlaUI wraps each handle via
/// <c>AutomationBase.FromHandle</c> (which talks directly to that
/// specific window's own UIA provider, not the desktop-children walk, so
/// it succeeds even for a handle the walk itself missed).
///
/// Every public method here is best-effort and NEVER throws — a failed
/// enumeration/lookup comes back as an empty list or a zeroed/blank
/// WindowInfo field, same "describe, don't crash" posture as every other
/// UIA/Win32 scan in this codebase (see PioneerRxPresence.cs for the same
/// pattern with plain GetForegroundWindow/GetWindowText calls).
/// </summary>
public static class Win32WindowEnumerator
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumThreadWindows(uint dwThreadId, EnumWindowsProc lpfn, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);

    // GetWindowLongPtr only exists as a real export on 64-bit Windows;
    // GetWindowLong is the correct call for a 32-bit process. Both are
    // wrapped by SafeGetStyle below, chosen by IntPtr.Size (this process'
    // own bitness) — same fallback pattern most Win32 P/Invoke code uses
    // for style-flag reads. Best-effort: a failure here just means
    // IsPopupStyle/IsDialogFrameStyle come back false, never a crash.
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
    private static extern int GetWindowLong32(IntPtr hWnd, int nIndex);

    private const uint GW_OWNER = 4;
    private const int GWL_STYLE = -16;
    private const long WS_POPUP = unchecked((long)0x80000000);
    private const long WS_DLGFRAME = 0x00400000L;

    /// <summary>Every top-level window Win32 currently knows about — the
    /// OS-level source of truth, independent of whatever UIA has or
    /// hasn't cataloged. Never throws (an EnumWindows failure comes back
    /// as an empty list).</summary>
    public static IReadOnlyList<WindowInfo> EnumerateTopLevelWindows()
    {
        var results = new List<WindowInfo>();
        try
        {
            EnumWindows((hWnd, _) =>
            {
                TryAdd(results, hWnd);
                return true;
            }, IntPtr.Zero);
        }
        catch
        {
            return Array.Empty<WindowInfo>();
        }
        return results;
    }

    /// <summary>Every top-level window belonging to `threadId` — owned
    /// dialogs are created on their owner's UI thread, so this is a
    /// second, narrower net alongside EnumerateTopLevelWindows (Will's
    /// brief names both EnumWindows and EnumThreadWindows explicitly).
    /// Never throws.</summary>
    public static IReadOnlyList<WindowInfo> EnumerateWindowsForThread(int threadId)
    {
        if (threadId <= 0) return Array.Empty<WindowInfo>();
        var results = new List<WindowInfo>();
        try
        {
            EnumThreadWindows((uint)threadId, (hWnd, _) =>
            {
                TryAdd(results, hWnd);
                return true;
            }, IntPtr.Zero);
        }
        catch
        {
            return Array.Empty<WindowInfo>();
        }
        return results;
    }

    /// <summary>The UI thread id that owns `hWnd` (0 on failure) — used to
    /// scope EnumerateWindowsForThread to the attached main window's own
    /// thread.</summary>
    public static int GetThreadId(IntPtr hWnd)
    {
        try
        {
            return (int)GetWindowThreadProcessId(hWnd, out _);
        }
        catch
        {
            return 0;
        }
    }

    /// <summary>Full WindowInfo for one already-known handle — used both
    /// internally (TryAdd) and by PioneerWindowInventory.EnumerateAllWindows
    /// to backfill owner/style data for a handle UIA saw but Win32's own
    /// EnumWindows pass, for whatever reason, didn't. Never throws.</summary>
    public static WindowInfo Describe(IntPtr hWnd)
    {
        var style = SafeGetStyle(hWnd);
        return new WindowInfo(
            hWnd,
            SafeGetWindowText(hWnd),
            SafeGetProcessId(hWnd),
            SafeGetOwner(hWnd),
            (style & WS_POPUP) != 0,
            (style & WS_DLGFRAME) != 0);
    }

    private static void TryAdd(List<WindowInfo> results, IntPtr hWnd)
    {
        try { results.Add(Describe(hWnd)); }
        catch { /* skip this window, keep enumerating — best-effort */ }
    }

    private static string SafeGetWindowText(IntPtr hWnd)
    {
        try
        {
            var buffer = new StringBuilder(512);
            var length = GetWindowText(hWnd, buffer, buffer.Capacity);
            return length > 0 ? buffer.ToString() : "";
        }
        catch { return ""; }
    }

    private static int SafeGetProcessId(IntPtr hWnd)
    {
        try
        {
            GetWindowThreadProcessId(hWnd, out var pid);
            return pid;
        }
        catch { return 0; }
    }

    private static IntPtr SafeGetOwner(IntPtr hWnd)
    {
        try { return GetWindow(hWnd, GW_OWNER); }
        catch { return IntPtr.Zero; }
    }

    private static long SafeGetStyle(IntPtr hWnd)
    {
        try
        {
            return IntPtr.Size == 8 ? GetWindowLongPtr64(hWnd, GWL_STYLE).ToInt64() : GetWindowLong32(hWnd, GWL_STYLE);
        }
        catch { return 0; }
    }
}
