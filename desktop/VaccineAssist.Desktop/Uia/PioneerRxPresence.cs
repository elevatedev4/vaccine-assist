using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace VaccineAssist.Desktop.Uia;

/// <summary>
/// Light "is PioneerRx around right now" check for the global-hotkey
/// handler (V-T3 item 2: "verify a PioneerRx window is present/foreground
/// (light title check like rx-verify's attach)") — deliberately cheaper
/// than PioneerRxAttachment's full FlaUI/UIA3 attach: two plain Win32
/// calls, no COM automation session. Same technique rx-verify's
/// Integrated/IntegratedOverlayCoordinator.DoesPioneerRxProcessExist and
/// PioneerRxWindow's GetForegroundWindow check use, just without FlaUI in
/// the loop at all.
/// </summary>
public static class PioneerRxPresence
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    /// <summary>See PioneerRxPresenceDecision.IsPresent — combines a foreground-title check with a running-process check. Never throws.</summary>
    public static bool IsPresent()
        => PioneerRxPresenceDecision.IsPresent(IsForegroundWindowPioneerRx(), IsProcessRunning());

    private static bool IsForegroundWindowPioneerRx()
    {
        try
        {
            var hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return false;

            var buffer = new StringBuilder(256);
            var length = GetWindowText(hwnd, buffer, buffer.Capacity);
            if (length <= 0) return false;

            var title = buffer.ToString();
            foreach (var prefix in PioneerRxTitles.TargetWindowTitlePrefixes)
            {
                if (title.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }
        catch
        {
            return false;
        }
    }

    private static bool IsProcessRunning()
    {
        foreach (var processName in PioneerRxTitles.TargetProcessNames)
        {
            Process[] processes;
            try
            {
                processes = Process.GetProcessesByName(processName);
            }
            catch
            {
                continue;
            }

            try
            {
                if (processes.Length > 0) return true;
            }
            finally
            {
                foreach (var process in processes) process.Dispose();
            }
        }
        return false;
    }
}
