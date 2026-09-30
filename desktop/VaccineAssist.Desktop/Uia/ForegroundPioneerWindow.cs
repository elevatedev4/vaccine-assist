using System;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using FlaUI.Core.AutomationElements;
using FlaUI.UIA3;

namespace VaccineAssist.Desktop.Uia;

/// <summary>
/// V-T41 R5 (Will, 2026-09-29 8:15pm brief, item 1): InputDirectionsStep's
/// directions-field search must look "under the attached window AND under
/// the foreground top-level Pioneer window if it differs" — the "Add New
/// Rx" screen the attached window points at may not be the SAME top-level
/// window that currently has OS foreground (e.g. a later dialog PioneerRx
/// raised on top of it), so the field could genuinely only be reachable
/// through the foreground one. This class answers exactly that "is the
/// current foreground window a DIFFERENT PioneerRx window" question, no
/// more — never throws, returns null on any failure or when the foreground
/// window isn't a PioneerRx window (or is the same window already attached).
/// </summary>
public static class ForegroundPioneerWindow
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    /// <summary>
    /// The current OS foreground window wrapped as an AutomationElement,
    /// ONLY when it belongs to a PioneerRx process (PioneerRxTitles.
    /// TargetProcessNames) and its native handle differs from
    /// <paramref name="attachedHandle"/>. Same "wrap via
    /// UIA3Automation.FromHandle inside a using-scoped automation session,
    /// return the element anyway" pattern PioneerRxAttachment.TryAttach
    /// already uses successfully — FlaUI's AutomationElement keeps working
    /// after its originating UIA3Automation is disposed.
    /// </summary>
    public static AutomationElement? TryGetIfDifferent(IntPtr attachedHandle)
    {
        try
        {
            var handle = GetForegroundWindow();
            if (handle == IntPtr.Zero || handle == attachedHandle)
            {
                return null;
            }

            using var automation = new UIA3Automation();
            AutomationElement? element;
            try { element = automation.FromHandle(handle); }
            catch { return null; }
            if (element is null) return null;

            int pid;
            try { pid = element.FrameworkAutomationElement.ProcessId; }
            catch { return null; }
            if (pid <= 0) return null;

            using var process = Process.GetProcessById(pid);
            var isPioneer = PioneerRxTitles.TargetProcessNames.Any(target =>
                string.Equals(target, process.ProcessName, StringComparison.OrdinalIgnoreCase));

            return isPioneer ? element : null;
        }
        catch
        {
            return null;
        }
    }
}
