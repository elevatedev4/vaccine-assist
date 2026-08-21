using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using FlaUI.Core.AutomationElements;
using FlaUI.UIA3;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Uia;

/// <summary>
/// Finds and attaches to the active PioneerRx window using UIA3, for the
/// data-entry sequence's FocusPioneerWindowStep. Modeled directly on
/// rx-verify's overlay/RxVerifyOverlay/Uia/PioneerRxWindow.cs (same "find
/// a top-level window whose title starts with a known prefix" approach)
/// but intentionally WITHOUT that class's attach-cache/latency
/// optimizations — this only runs once per data-entry popup session (not
/// on a fast repeating refresh timer like rx-verify's overlay), so the
/// extra complexity isn't earning its keep here. Revisit if that changes.
///
/// TITLE CAVEAT: see PioneerRxTitles.cs — the exact window this should
/// attach to for vaccine entry hasn't been confirmed against a live UIA
/// dump yet. TryAttach matches the same prefixes rx-verify confirmed for
/// its own (Rx Profile) screens as the best available signal.
///
/// WIDENED MATCH (Will, 2026-08-19/20: "Enter into Pioneer" popup said
/// "FAILED - No PioneerRx window" on a live machine): the original match
/// was StartsWith-only against window title. Now widened two ways —
/// title match is Contains instead of StartsWith (a title like
/// "PioneerRx - Edit Rx - Smith, John" never matched before; some
/// PioneerRx builds/skins prefix the app name onto every window title),
/// and a process-name fallback (PioneerRxTitles.TargetProcessNames) picks
/// up any top-level window belonging to a PioneerRx process even if its
/// title doesn't match anything on the known-prefix list at all — the
/// exact situation to expect on a screen nobody's confirmed a UIA dump
/// for yet (see PioneerRxTitles.cs's own caveat).
/// </summary>
public static class PioneerRxAttachment
{
    /// <summary>
    /// Attempts to find a top-level window matching PioneerRxTitles (see
    /// class doc comment for the widened match). Returns null (never
    /// throws) if none is open or the UIA session itself fails — callers
    /// treat that as "PioneerRx not found" and fall back accordingly
    /// (dry-run / clipboard), never crash. Also logs, to AppFileLog, the
    /// SCREEN-NAME-ONLY portion of every top-level window it saw when the
    /// attach fails, so a real "no window found" report can be diagnosed
    /// without a live UIA dump session.
    /// </summary>
    public static AutomationElement? TryAttach()
    {
        try
        {
            using var automation = new UIA3Automation();
            var desktop = automation.GetDesktop();
            var allTopLevel = desktop.FindAllChildren();

            var candidates = new List<AutomationElement>();
            var observed = new List<string>();

            foreach (var window in allTopLevel)
            {
                string? name;
                try { name = window.Name; }
                catch { continue; }

                if (string.IsNullOrEmpty(name)) continue;

                var processName = TryGetProcessName(window);
                observed.Add(DescribeForLog(name, processName));

                var titleMatches = PioneerRxTitles.TargetWindowTitlePrefixes.Any(prefix =>
                    name.Contains(prefix, StringComparison.OrdinalIgnoreCase));
                var processMatches = processName is not null &&
                    PioneerRxTitles.TargetProcessNames.Any(target =>
                        string.Equals(target, processName, StringComparison.OrdinalIgnoreCase));

                if (titleMatches || processMatches)
                {
                    candidates.Add(window);
                }
            }

            if (candidates.Count > 0)
            {
                // Single-candidate is the common case; with more than one
                // open, first-match is an acceptable simplification for
                // phase 1 (unlike rx-verify's refresh-timer loop, this
                // isn't at risk of getting permanently stuck on a stale
                // window — the pharmacist re-triggers the hotkey per
                // patient).
                return candidates[0];
            }

            // NO PHI: title is truncated to the portion before the first
            // " - " (the pattern PioneerRxTitles' own prefixes assume,
            // e.g. "Edit Rx" from "Edit Rx - Smith, John") — never the
            // full title text, in case a real window's title puts patient
            // identifiers after that delimiter.
            AppFileLog.Log(observed.Count == 0
                ? "[PioneerRxAttachment] No top-level windows observed at all."
                : $"[PioneerRxAttachment] No PioneerRx window matched. Observed {observed.Count} top-level window(s): {string.Join(" | ", observed)}");
            return null;
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("PioneerRxAttachment.TryAttach", ex);
            return null;
        }
    }

    private static string? TryGetProcessName(AutomationElement window)
    {
        try
        {
            var pid = window.FrameworkAutomationElement.ProcessId;
            if (pid <= 0) return null;
            using var process = Process.GetProcessById(pid);
            return process.ProcessName;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>NO PHI — see TryAttach's doc comment on why the title is truncated before logging.</summary>
    private static string DescribeForLog(string title, string? processName)
    {
        var screenNameOnly = title.Split(new[] { " - " }, 2, StringSplitOptions.None)[0];
        return processName is null ? $"\"{screenNameOnly}\"" : $"\"{screenNameOnly}\" (process: {processName})";
    }
}
