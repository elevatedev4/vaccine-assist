using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Runtime.InteropServices;
using VaccineAssist.Desktop.Uia;

namespace VaccineAssist.Desktop.Overlay;

/// <summary>
/// Finds PioneerRx's own top-level window for the overlay icon to anchor
/// to (Will's brief, Part 4: "find by process name using the existing
/// PioneerRxTitles.TargetProcessNames / a UIA or Win32 top-level window
/// scan; prefer the foreground Pioneer window; cache the HWND like Rx
/// Verify does, re-resolve when IsWindow fails"). Plain Win32
/// (EnumWindows + GetWindowThreadProcessId filtered to
/// Uia/PioneerRxTitles.TargetProcessNames) — no FlaUI/UIA session needed
/// just to find a window's rect, same "cheap Win32-only" posture as
/// Uia/PioneerRxPresence.cs.
///
/// Deliberately simpler than rx-verify's own MainWindowAnchorRule (no
/// maximized-only requirement, no focus-follow sticky logic) — this icon
/// just needs to sit near whatever Pioneer window is currently in front;
/// it isn't drawing verdict boxes that must never jump to the wrong
/// window mid-gesture the way rx-verify's integrated boxes layer is.
/// </summary>
public static class PioneerMainWindowLocator
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out NativeRect lpRect);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    private static IntPtr _cachedHandle = IntPtr.Zero;
    private static readonly Dictionary<uint, bool> _pidIsPioneerCache = new();

    /// <summary>
    /// True (with <paramref name="bounds"/>/<paramref name="isMinimized"/>
    /// populated) when a PioneerRx top-level window is currently open;
    /// false when none is. Never throws.
    /// </summary>
    public static bool TryGetMainWindow(out Rectangle bounds, out bool isMinimized)
    {
        try
        {
            // Fast path — same "when in doubt, re-resolve" posture as
            // rx-verify's own PioneerRxWindow.TryAttach fast path: reuse
            // the cached handle only while it's still a real window.
            if (_cachedHandle != IntPtr.Zero && IsWindow(_cachedHandle) && IsWindowVisible(_cachedHandle))
            {
                if (GetWindowRect(_cachedHandle, out var cachedRect) && IsSaneRect(cachedRect))
                {
                    bounds = ToRectangle(cachedRect);
                    isMinimized = IsIconic(_cachedHandle);
                    return true;
                }
            }

            var candidates = EnumeratePioneerTopLevelWindows();
            if (candidates.Count == 0)
            {
                _cachedHandle = IntPtr.Zero;
                bounds = Rectangle.Empty;
                isMinimized = false;
                return false;
            }

            var foreground = GetForegroundWindow();
            var chosen = candidates.FirstOrDefault(c => c.Handle == foreground);
            if (chosen.Handle == IntPtr.Zero)
            {
                // Nothing foreground among Pioneer's own windows — prefer
                // the largest (most likely the real main window, not a
                // small popup/dialog).
                chosen = candidates.OrderByDescending(c => (long)c.Bounds.Width * c.Bounds.Height).First();
            }

            _cachedHandle = chosen.Handle;
            bounds = chosen.Bounds;
            isMinimized = chosen.IsMinimized;
            return true;
        }
        catch
        {
            bounds = Rectangle.Empty;
            isMinimized = false;
            return false;
        }
    }

    private static bool IsSaneRect(NativeRect rect) => rect.Right > rect.Left && rect.Bottom > rect.Top;

    private static Rectangle ToRectangle(NativeRect rect) => Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);

    private static List<(IntPtr Handle, Rectangle Bounds, bool IsMinimized)> EnumeratePioneerTopLevelWindows()
    {
        var candidates = new List<(IntPtr, Rectangle, bool)>();

        EnumWindows((hWnd, _) =>
        {
            if (!IsWindowVisible(hWnd))
            {
                return true; // keep enumerating
            }

            GetWindowThreadProcessId(hWnd, out var pid);
            if (!IsPioneerProcessId(pid))
            {
                return true;
            }

            if (!GetWindowRect(hWnd, out var rect) || !IsSaneRect(rect))
            {
                return true;
            }

            candidates.Add((hWnd, ToRectangle(rect), IsIconic(hWnd)));
            return true;
        }, IntPtr.Zero);

        return candidates;
    }

    private static bool IsPioneerProcessId(uint pid)
    {
        if (_pidIsPioneerCache.TryGetValue(pid, out var cached))
        {
            return cached;
        }

        var isPioneer = false;
        try
        {
            using var process = Process.GetProcessById((int)pid);
            isPioneer = PioneerRxTitles.TargetProcessNames.Any(
                name => string.Equals(process.ProcessName, name, StringComparison.OrdinalIgnoreCase));
        }
        catch
        {
            // Process exited between EnumWindows and here, or access denied — not Pioneer as far as we can tell.
        }

        _pidIsPioneerCache[pid] = isPioneer;
        return isPioneer;
    }
}
