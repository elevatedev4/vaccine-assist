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
///
/// V-... 2026-09-14 (Will, verbatim): "The app is not recognizing the
/// Pioneer windows that pop up and is instead trying to stay focused and
/// work in the Pioneer main window." Describe() (and the new
/// EnumerateAllWindows/FindBlockingWindow below) now source their
/// top-level window list from EnumerateAllWindows, which unions a raw
/// Win32 EnumWindows/EnumThreadWindows walk with the existing UIA desktop
/// scan (see Win32WindowEnumerator's own doc comment for why the Win32
/// half exists) — so this diagnostic actually reflects the same,
/// corrected enumeration SendF3AndDismissPreEntryDialogsStep now uses to
/// find dialogs, instead of silently staying blind to whatever UIA alone
/// was missing.
/// </summary>
public static class PioneerWindowInventory
{
    private const int MaxControlsPerWindow = 10;

    /// <summary>
    /// Every top-level PioneerRx window, plus each one's modal/dialog
    /// descendants, joined into one log-line-friendly string. Returns a
    /// short, explicit message (never throws, never blank) when no
    /// PioneerRx window is visible at all or the scan itself fails.
    /// </summary>
    public static string Describe()
    {
        try
        {
            var topLevelWindows = EnumerateAllWindows();
            if (topLevelWindows.Count == 0)
            {
                return "No PioneerRx window found.";
            }

            var lines = new List<string> { $"{topLevelWindows.Count} PioneerRx top-level window(s):" };
            foreach (var (window, _) in topLevelWindows)
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

    /// <summary>
    /// Every top-level window belonging to a PioneerRx process, gathered
    /// from BOTH a raw Win32 EnumWindows walk (Win32WindowEnumerator —
    /// catches a window UIA's own desktop-children walk hasn't/won't
    /// surface) AND FlaUI/UIA3's Desktop.FindAllChildren() scan (still
    /// needed here since it's the cheapest way to get a window's Name for
    /// a handle Win32's own GetWindowText call might come back blank
    /// for), deduped by HWND. Every handle — including one Win32-only
    /// source saw — is wrapped into an AutomationElement via
    /// AutomationBase.FromHandle, which talks directly to that specific
    /// window's own UIA provider rather than depending on the
    /// desktop-children walk, so it succeeds even for a handle that walk
    /// itself missed. Never throws — a failed scan comes back as an empty
    /// list, same posture as every other method here.
    /// </summary>
    public static IReadOnlyList<(AutomationElement Element, WindowInfo Info)> EnumerateAllWindows()
    {
        var byHandle = new Dictionary<IntPtr, WindowInfo>();

        try
        {
            foreach (var info in Win32WindowEnumerator.EnumerateTopLevelWindows())
            {
                if (info.Handle != IntPtr.Zero && IsTargetProcessId(info.ProcessId))
                {
                    byHandle[info.Handle] = info;
                }
            }
        }
        catch
        {
            // best-effort — the UIA pass below still runs regardless.
        }

        var result = new List<(AutomationElement, WindowInfo)>();
        try
        {
            using var automation = new UIA3Automation();

            foreach (var window in automation.GetDesktop().FindAllChildren())
            {
                if (!IsPioneerProcessWindow(window)) continue;

                IntPtr handle;
                try { handle = window.FrameworkAutomationElement.NativeWindowHandle ?? IntPtr.Zero; }
                catch { continue; }
                if (handle == IntPtr.Zero) continue;

                var name = SafeGet(() => window.Name ?? "");
                var pid = SafeGetProcessId(window);

                if (byHandle.TryGetValue(handle, out var existing))
                {
                    if (string.IsNullOrEmpty(existing.Title) && !string.IsNullOrEmpty(name))
                    {
                        byHandle[handle] = existing with { Title = name };
                    }
                }
                else
                {
                    // Win32's own EnumWindows pass didn't have this handle
                    // (rare — UIA saw it, Win32's walk somehow didn't) —
                    // backfill owner/style via a direct Describe() call so
                    // PioneerDialogCandidates.Select's callers still get
                    // that data.
                    var w32 = Win32WindowEnumerator.Describe(handle);
                    byHandle[handle] = w32 with
                    {
                        Title = string.IsNullOrEmpty(w32.Title) ? name : w32.Title,
                        ProcessId = pid > 0 ? pid : w32.ProcessId,
                    };
                }
            }

            foreach (var info in byHandle.Values)
            {
                AutomationElement? element;
                try { element = automation.FromHandle(info.Handle); }
                catch { element = null; }
                if (element is not null) result.Add((element, info));
            }
        }
        catch
        {
            // best-effort — see class doc comment.
        }
        return result;
    }

    /// <summary>V-... 2026-09-14 (Will, verbatim): "the app is ... trying
    /// to stay focused and work in the Pioneer main window" instead of
    /// recognizing a popup that's actually blocking it. Used by
    /// QuickSearchFieldEntry so a field that's disabled mid-entry (or a
    /// dialog that appears mid-entry) STOPS and reports which window
    /// blocked it instead of retrying (clicking/typing) against the main
    /// window while that window is up. Returns a short NO-PHI description
    /// (DescribeOne — same truncate-before-" - " rule as the rest of this
    /// class) of the first OTHER enabled top-level PioneerRx window besides
    /// `excludeHandle`, or null when none is visible. Never throws.</summary>
    public static string? FindBlockingWindow(IntPtr excludeHandle)
    {
        try
        {
            foreach (var (window, info) in EnumerateAllWindows())
            {
                if (info.Handle == IntPtr.Zero || info.Handle == excludeHandle) continue;

                bool isEnabled;
                try { isEnabled = window.Properties.IsEnabled.ValueOrDefault; }
                catch { isEnabled = true; } // best-effort: "can't tell" treated as potentially blocking

                if (!isEnabled) continue;

                return DescribeOne(window);
            }
        }
        catch
        {
            // best-effort — see class doc comment.
        }
        return null;
    }

    private static bool IsTargetProcessId(int processId)
    {
        if (processId <= 0) return false;
        try
        {
            using var process = Process.GetProcessById(processId);
            return PioneerRxTitles.TargetProcessNames.Any(target =>
                string.Equals(target, process.ProcessName, StringComparison.OrdinalIgnoreCase));
        }
        catch
        {
            return false;
        }
    }

    private static int SafeGetProcessId(AutomationElement window)
    {
        try { return window.FrameworkAutomationElement.ProcessId; }
        catch { return 0; }
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
