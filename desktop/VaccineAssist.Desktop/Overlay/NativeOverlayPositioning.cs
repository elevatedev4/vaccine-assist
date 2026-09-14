using System;
using System.Runtime.InteropServices;

namespace VaccineAssist.Desktop.Overlay;

/// <summary>
/// Win32 SetWindowPos wrapper for the Pioneer overlay icon — physical
/// pixels only (never WPF's Left/Top, which are DIPs), same reasoning as
/// rx-verify's Integrated/NativeWindowPositioning.cs: PioneerMainWindowLocator's
/// bounds are already physical (straight from GetWindowRect), so lining
/// up with them needs no conversion; DPI only matters for sizing the
/// icon itself (see OverlayPlacement).
/// </summary>
internal static class NativeOverlayPositioning
{
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_SHOWWINDOW = 0x0040;
    private const uint SWP_HIDEWINDOW = 0x0080;

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hWnd);

    /// <summary>Moves/resizes/(re)shows or hides without disturbing z-order or stealing activation — safe to call every ~250ms tick. A no-op if the window's HWND doesn't exist yet.</summary>
    public static void Reposition(IntPtr hwnd, int x, int y, int width, int height, bool show)
    {
        if (hwnd == IntPtr.Zero)
        {
            return;
        }
        var flags = SWP_NOACTIVATE | SWP_NOZORDER | (show ? SWP_SHOWWINDOW : SWP_HIDEWINDOW);
        SetWindowPos(hwnd, IntPtr.Zero, x, y, width, height, flags);
    }

    /// <summary>1.0 (96 DPI, "no scaling") on a Zero hwnd or a failed GetDpiForWindow call.</summary>
    public static double DpiScaleFor(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero)
        {
            return 1.0;
        }
        var dpi = GetDpiForWindow(hwnd);
        return dpi > 0 ? dpi / 96.0 : 1.0;
    }
}
