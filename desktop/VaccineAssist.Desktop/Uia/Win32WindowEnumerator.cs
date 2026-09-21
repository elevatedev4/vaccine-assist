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
///
/// V-T41 (Will, 2026-09-13 night — Auto-Suggest Dropdown timeout follow-up):
/// `ClassName` (the raw Win32 window class, e.g. "Auto-Suggest Dropdown",
/// "tooltips_class32") was added so DialogClassifier.IsTransientWindow can
/// tell Pioneer's own transient popups (autocomplete dropdowns, tooltips)
/// apart from a real pre-entry dialog using nothing but this struct's own
/// fields — see that method.
///
/// V-T41 ROUND 3 (Will, 2026-09-21 log — Priority/untitled-window Escape
/// loop): `IsVisible`/`IsEnabled`/`Width`/`Height`/`Style`/`ExStyle` were
/// added so DialogClassifier can tell an invisible/disabled/zero-area
/// owner-or-notification window (e.g. WinForms' own hidden
/// "ThemeManagerNotification" window, or an untitled
/// "WindowsForms10.Window.0.*" support window) apart from a real modal
/// dialog, and so a candidate can be checked against the main window's
/// OWN enabled state (a real modal disables its owner) before ever being
/// Escaped — see IsTransientWindow and IsConfirmedBlockingModal. `Width`/
/// `Height` default to -1 ("not measured") rather than 0 so an existing
/// test fixture that never set them is never mistaken for a zero-area
/// window; `IsVisible`/`IsEnabled` default to true (assume normal) for the
/// same backward-compatibility reason. All six are appended as the LAST
/// fields with defaults so every existing positional `new WindowInfo(...)`
/// call (this class' Describe below, and every fixture in
/// PioneerDialogCandidatesTests.cs / DialogClassifierTests.cs) keeps
/// compiling unchanged.
/// </summary>
public readonly record struct WindowInfo(
    IntPtr Handle,
    string Title,
    int ProcessId,
    IntPtr OwnerHandle,
    bool IsPopupStyle,
    bool IsDialogFrameStyle,
    string ClassName = "",
    bool IsVisible = true,
    bool IsEnabled = true,
    int Width = -1,
    int Height = -1,
    long Style = 0,
    long ExStyle = 0)
{
    private const long WS_EX_TOOLWINDOW = 0x00000080L;
    private const long WS_EX_NOACTIVATE = 0x08000000L;

    /// <summary>WS_EX_TOOLWINDOW — a tool window never appears in the
    /// taskbar/Alt+Tab and is never a real modal dialog PioneerRx expects
    /// the user to answer.</summary>
    public bool IsToolWindow => (ExStyle & WS_EX_TOOLWINDOW) != 0;

    /// <summary>WS_EX_NOACTIVATE — a window that never takes activation
    /// (used for notification/owner-only helper windows) is never a real
    /// modal dialog either.</summary>
    public bool IsNoActivateWindow => (ExStyle & WS_EX_NOACTIVATE) != 0;

    /// <summary>True only when Width/Height were actually measured (not
    /// left at their -1 "unmeasured" default) and came back 0 on either
    /// axis — the shape of an invisible support window Win32 still reports
    /// a handle for.</summary>
    public bool HasZeroArea => Width == 0 || Height == 0;
}

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

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowEnabled(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

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
    private const int GWL_EXSTYLE = -20;
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
        var exStyle = SafeGetExStyle(hWnd);
        var (width, height) = SafeGetSize(hWnd);
        return new WindowInfo(
            hWnd,
            SafeGetWindowText(hWnd),
            SafeGetProcessId(hWnd),
            SafeGetOwner(hWnd),
            (style & WS_POPUP) != 0,
            (style & WS_DLGFRAME) != 0,
            SafeGetClassName(hWnd),
            IsVisible: SafeIsVisible(hWnd),
            IsEnabled: SafeIsEnabled(hWnd),
            Width: width,
            Height: height,
            Style: style,
            ExStyle: exStyle);
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

    private static string SafeGetClassName(IntPtr hWnd)
    {
        try
        {
            var buffer = new StringBuilder(256);
            var length = GetClassName(hWnd, buffer, buffer.Capacity);
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

    private static long SafeGetExStyle(IntPtr hWnd)
    {
        try
        {
            return IntPtr.Size == 8 ? GetWindowLongPtr64(hWnd, GWL_EXSTYLE).ToInt64() : GetWindowLong32(hWnd, GWL_EXSTYLE);
        }
        catch { return 0; }
    }

    /// <summary>Width/Height in screen pixels, or (-1, -1) — "not
    /// measured" — on any failure, matching WindowInfo's own default so a
    /// failed measurement is never mistaken for a genuine zero-area
    /// window.</summary>
    private static (int Width, int Height) SafeGetSize(IntPtr hWnd)
    {
        try
        {
            if (GetWindowRect(hWnd, out var rect))
            {
                return (rect.Right - rect.Left, rect.Bottom - rect.Top);
            }
        }
        catch { /* fall through to (-1, -1) below */ }
        return (-1, -1);
    }

    /// <summary>Best-effort: "can't tell" is treated as visible (true),
    /// same safe-default posture WindowInfo's own default uses.</summary>
    private static bool SafeIsVisible(IntPtr hWnd)
    {
        try { return IsWindowVisible(hWnd); }
        catch { return true; }
    }

    /// <summary>Best-effort: "can't tell" is treated as enabled (true),
    /// same safe-default posture WindowInfo's own default uses.</summary>
    private static bool SafeIsEnabled(IntPtr hWnd)
    {
        try { return IsWindowEnabled(hWnd); }
        catch { return true; }
    }

    /// <summary>
    /// V-T41 ROUND 4 (Will's 2026-09-21 brief, point 1): "make 'OK' mean
    /// VERIFIED: ... wait up to ~1.5s for that dialog HWND to be gone
    /// (IsWindow false / not visible)." True once the handle no longer
    /// refers to a live window at all, OR still exists but is no longer
    /// visible (a dialog that's been hidden rather than destroyed still
    /// counts as "gone" for this purpose). Fail-safe in the SAFE direction
    /// for this specific use (unlike SafeIsVisible/SafeIsEnabled above): a
    /// read failure returns false ("not gone yet") so a strategy can never
    /// falsely claim success from an unreadable handle.
    /// </summary>
    public static bool IsWindowGone(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero) return true;
        try { return !IsWindow(hWnd) || !IsWindowVisible(hWnd); }
        catch { return false; }
    }

    /// <summary>True when `hWnd` is currently the foreground window — used
    /// by the Priority dialog's keyboard strategy (point 2b of the brief:
    /// "verify foreground == dialog hwnd first; if not, SetForegroundWindow
    /// it") before sending any keystrokes, since Windows delivers keyboard
    /// input to whichever window has focus, not necessarily the window a
    /// caller intends. Never throws.</summary>
    public static bool IsForegroundWindow(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero) return false;
        try { return GetForegroundWindow() == hWnd; }
        catch { return false; }
    }

    /// <summary>Best-effort SetForegroundWindow — Windows can refuse a
    /// foreground-switch request from a background process depending on
    /// focus-stealing rules, so this is never guaranteed to succeed; the
    /// caller re-checks IsForegroundWindow (or simply proceeds best-effort)
    /// rather than treating a failure here as fatal. Never throws.</summary>
    public static void TryBringToForeground(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero) return;
        try { SetForegroundWindow(hWnd); }
        catch { /* best-effort — see doc comment above */ }
    }

    /// <summary>
    /// V-T41 ROUND 4 REVIEW FIX (BLOCKER 1 — safety reviewer): the raw
    /// foreground HWND, exposed so SendF3AndDismissPreEntryDialogsStep.
    /// TryAuthorizeDialogInput can Describe() it and check whether it's a
    /// same-process 'ComboLBox' popup (the one window besides the dialog
    /// itself ever accepted as safe to send raw keystrokes/clicks to — see
    /// PriorityInputGuard) rather than only being able to compare it
    /// against a single known handle the way IsForegroundWindow does.
    /// Never throws (IntPtr.Zero on failure).
    /// </summary>
    public static IntPtr GetForegroundWindowHandle()
    {
        try { return GetForegroundWindow(); }
        catch { return IntPtr.Zero; }
    }
}
