using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Conditions;
using FlaUI.Core.Definitions;
using FlaUI.UIA3;

namespace VaccineAssist.Desktop.Uia;

/// <summary>
/// V-T41 (Will, 2026-09-13 night, verbatim app.log excerpt): "the app is
/// still getting stuck on the pre-data entry popup windows" — that night's
/// build showed the combined pre-entry loop
/// (SendF3AndDismissPreEntryDialogsStep.RunCombinedPreEntryLoopAsync)
/// finish with "0 window(s) dismissed, ready=True", then the very next
/// step spent its whole retry budget (40+ seconds) hitting
/// ElementNotEnabledException on uxPrescriberQuickSearch — consistent with
/// either a modal this repo doesn't recognize still sitting in front of
/// "Add New Rx" when readiness was declared, or the screen still finishing
/// its render.
///
/// This class is the diagnostic half of that fix: a NO-PHI (structure
/// only, same rule as AppFileLog's own "NO PHI" contract — see
/// PioneerRxAttachment.TryAttach's DescribeForLog and
/// SendF3AndDismissPreEntryDialogsStep.DescribeAnyPioneerWindowForLog,
/// which both truncate a window's title to the portion before the first
/// " - " for the same reason) inventory of every top-level window
/// belonging to the PioneerRx process, PLUS every modal/dialog-shaped
/// descendant of each one — title, class name, AutomationId, whether it's
/// modal (UIA WindowPattern.IsModal), whether it's enabled, its screen
/// bounds, and the names of its first ~<see cref="MaxControlsPerWindow"/>
/// buttons/combo boxes — so the NEXT stall's app.log names exactly what
/// was on screen instead of just "still waiting."
///
/// Called from two places: QuickSearchFieldEntry.WaitForFieldAsync (once a
/// quick-search field has been present-but-disabled for more than ~2s —
/// see StallInventoryThreshold there) and
/// SendF3AndDismissPreEntryDialogsStep.ExecuteAsync (once, right after the
/// combined loop finishes, whenever it dismissed 0 windows — the EXACT
/// shape of the V-T41 log line above).
///
/// Never throws — a failed scan comes back as a single describable string,
/// same "best-effort, describe don't crash" posture as every other UIA
/// scan in this codebase.
/// </summary>
public static class PioneerWindowInventory
{
    private const int MaxControlsPerWindow = 10;

    /// <summary>
    /// Every top-level PioneerRx window, plus each one's modal/dialog
    /// descendants, joined into one log-line-friendly string. Returns a
    /// short, explicit message (never throws, never blank) when no
    /// PioneerRx window is visible at all or the desktop scan itself
    /// fails.
    /// </summary>
    public static string Describe()
    {
        try
        {
            using var automation = new UIA3Automation();
            var desktop = automation.GetDesktop();

            var topLevelWindows = new List<AutomationElement>();
            foreach (var window in desktop.FindAllChildren())
            {
                if (IsPioneerProcessWindow(window)) topLevelWindows.Add(window);
            }

            if (topLevelWindows.Count == 0)
            {
                return "No PioneerRx window found.";
            }

            var lines = new List<string> { $"{topLevelWindows.Count} PioneerRx top-level window(s):" };
            foreach (var window in topLevelWindows)
            {
                lines.Add("top-level " + DescribeOne(window));
                foreach (var child in FindModalOrDialogDescendants(window))
                {
                    lines.Add("child " + DescribeOne(child));
                }
            }
            return string.Join(" \\ ", lines);
        }
        catch (Exception ex)
        {
            return $"<window inventory failed: {ex.GetType().Name}: {ex.Message}>";
        }
    }

    private static IEnumerable<AutomationElement> FindModalOrDialogDescendants(AutomationElement window)
    {
        try
        {
            var condition = new OrCondition(new ConditionBase[]
            {
                window.ConditionFactory.ByControlType(ControlType.Window),
                window.ConditionFactory.ByControlType(ControlType.Pane),
                window.ConditionFactory.ByControlType(ControlType.Custom),
            });
            return window.FindAllDescendants(condition);
        }
        catch
        {
            return Array.Empty<AutomationElement>();
        }
    }

    private static string DescribeOne(AutomationElement element)
    {
        var title = SafeTitle(element);
        var className = SafeGet(() => element.ClassName ?? "<null>");
        var automationId = SafeGet(() => element.AutomationId ?? "<null>");
        var bounds = SafeGet(() => element.BoundingRectangle.ToString());
        var isEnabled = SafeGet(() => element.Properties.IsEnabled.ValueOrDefault.ToString());
        var isModal = SafeGet(() => DescribeIsModal(element));
        var controls = DescribeControls(element);

        return $"\"{title}\" class='{className}' id='{automationId}' isModal={isModal} isEnabled={isEnabled} bounds={bounds} controls=[{controls}]";
    }

    private static string DescribeIsModal(AutomationElement element)
    {
        if (!element.Patterns.Window.IsSupported) return "n/a";
        return element.Patterns.Window.Pattern.IsModal.ValueOrDefault.ToString();
    }

    /// <summary>First ~<see cref="MaxControlsPerWindow"/> button/combo box
    /// names found in `element` — enough to tell "Priority" picker dialogs
    /// apart from "Scan Hard Copy"/"Patient on Cycle Fill" prompts without
    /// dumping the whole subtree. Never throws.</summary>
    private static string DescribeControls(AutomationElement element)
    {
        try
        {
            var condition = new OrCondition(new ConditionBase[]
            {
                element.ConditionFactory.ByControlType(ControlType.Button),
                element.ConditionFactory.ByControlType(ControlType.ComboBox),
            });

            var names = element.FindAllDescendants(condition)
                .Take(MaxControlsPerWindow)
                .Select(c => SafeGet(() => string.IsNullOrEmpty(c.Name) ? "<unnamed>" : c.Name));
            return string.Join(", ", names);
        }
        catch
        {
            return "<error>";
        }
    }

    /// <summary>NO PHI — truncated to the portion before the first " - ",
    /// same convention as PioneerRxAttachment.TryAttach's DescribeForLog.</summary>
    private static string SafeTitle(AutomationElement element)
    {
        var name = SafeGet(() => element.Name ?? "");
        return name.Split(new[] { " - " }, 2, StringSplitOptions.None)[0];
    }

    private static string SafeGet(Func<string> getter)
    {
        try { return getter(); } catch { return "<unknown>"; }
    }

    private static bool IsPioneerProcessWindow(AutomationElement window)
    {
        try
        {
            var pid = window.FrameworkAutomationElement.ProcessId;
            if (pid <= 0) return false;
            using var process = Process.GetProcessById(pid);
            return PioneerRxTitles.TargetProcessNames.Any(target =>
                string.Equals(target, process.ProcessName, StringComparison.OrdinalIgnoreCase));
        }
        catch
        {
            return false;
        }
    }
}
