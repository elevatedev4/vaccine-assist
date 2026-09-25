using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using VaccineAssist.Desktop.Logging;
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
/// 2026-09-25 (Will, verbatim: "The icon for Pioneer overlay needs to
/// follow the user to the active pioneer window (focused window), like
/// RxOverlay does. We always have two pioneers open."): every tick now
/// enumerates ALL of PioneerRx's own top-level windows (not just a
/// cached one) and hands them, plus GetForegroundWindow(), to the pure
/// PioneerWindowAnchorRule.Resolve — this is the SAME "supply Win32 data
/// every tick, let a pure rule decide" split rx-verify's own
/// IntegratedOverlayCoordinator + MainWindowAnchorRule already use at an
/// equal-or-faster cadence, so a full EnumWindows scan every ~250ms is a
/// proven-cheap pattern in this codebase, not a new cost. This replaced
/// a narrower "reuse the cached HWND while IsWindow/IsWindowVisible
/// still hold, full re-scan only on a cache miss" fast path that never
/// re-checked the foreground window at all once locked onto one Pioneer
/// instance — which is exactly why switching focus between two open
/// PioneerRx windows previously did nothing.
///
/// Still deliberately simpler than rx-verify's own MainWindowAnchorRule:
/// no maximized-only requirement (see PioneerWindowAnchorRule's own doc
/// comment) — this icon just needs to sit near whatever Pioneer window
/// is currently in front; it isn't drawing verdict boxes that must never
/// jump to the wrong window mid-gesture the way rx-verify's integrated
/// boxes layer is.
/// </summary>
public static class PioneerMainWindowLocator
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out NativeRect lpRect);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

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
            var candidates = EnumeratePioneerTopLevelWindows();
            var foreground = GetForegroundWindow();
            var anchor = PioneerWindowAnchorRule.Resolve(_cachedHandle, candidates, foreground);

            if (anchor is null)
            {
                _cachedHandle = IntPtr.Zero;
                bounds = Rectangle.Empty;
                isMinimized = false;
                return false;
            }

            if (anchor.Value.Handle != _cachedHandle)
            {
                LogTargetChange(anchor.Value.Handle);
            }

            _cachedHandle = anchor.Value.Handle;
            bounds = anchor.Value.Bounds;
            isMinimized = anchor.Value.IsMinimized;
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

    private static List<PioneerWindowAnchorRule.Candidate> EnumeratePioneerTopLevelWindows()
    {
        var candidates = new List<PioneerWindowAnchorRule.Candidate>();

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

            candidates.Add(new PioneerWindowAnchorRule.Candidate(hWnd, true, IsIconic(hWnd), ToRectangle(rect)));
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

    /// <summary>Logged once per anchor change (never every tick) — see PioneerOverlayController's own "never spam on every 250ms tick" posture for exceptions.</summary>
    private static void LogTargetChange(IntPtr handle)
    {
        try
        {
            var title = ReadWindowTitleForLog(handle);
            AppFileLog.Log($"[Overlay] following hwnd=0x{handle:X} title=\"{title}\"");
        }
        catch
        {
            // Logging must never break window tracking — see AppFileLog's own "never the reason a command fails" posture.
        }
    }

    /// <summary>NO PHI: returns only the screen-name-only portion of the
    /// window title — the part before the first " - " — same truncation
    /// Uia/PioneerRxAttachment.DescribeForLog uses, since PioneerRx
    /// titles can carry patient names after that delimiter (e.g. "Edit
    /// Rx - Smith, John"). Never the full title text.</summary>
    private static string ReadWindowTitleForLog(IntPtr hWnd)
    {
        var buffer = new StringBuilder(256);
        var length = GetWindowText(hWnd, buffer, buffer.Capacity);
        var title = length > 0 ? buffer.ToString() : "";
        return title.Split(new[] { " - " }, 2, StringSplitOptions.None)[0];
    }
}
