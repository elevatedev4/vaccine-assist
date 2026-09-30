using System;
using System.Collections.Generic;
using System.Linq;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Conditions;
using FlaUI.Core.Definitions;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

namespace VaccineAssist.Desktop.Uia;

/// <summary>
/// V-T41 R5 (Will's brief, item 1): "log ONE compact UIA dump of every
/// enabled Edit/Document/ComboBox descendant of the Add New Rx screen:
/// AutomationId, Name, ClassName, ControlType, bounds (no field VALUES —
/// they can contain patient data)" — used by InputDirectionsStep right
/// before it fails, so a real "couldn't find the directions field" report
/// carries exactly what WAS on screen instead of just a guess. Deliberately
/// narrower than Uia/UiaTreeDumper (which walks the WHOLE tree and reads
/// truncated field values, meant for a one-off manual capture Will
/// attaches to a message himself) — this is a small, automatic,
/// NO-PHI-by-construction snapshot logged inline.
/// </summary>
public static class EditableFieldDumper
{
    /// <summary>Same "best-effort, never throw" posture as every other UIA
    /// scan in this codebase (e.g. Uia/PioneerWindowInventory). Returns an
    /// empty list on any failure rather than propagating.</summary>
    public static IReadOnlyList<FieldDescriptor> Collect(AutomationElement window)
    {
        var results = new List<FieldDescriptor>();
        try
        {
            var condition = new OrCondition(new ConditionBase[]
            {
                window.ConditionFactory.ByControlType(ControlType.Edit),
                window.ConditionFactory.ByControlType(ControlType.Document),
                window.ConditionFactory.ByControlType(ControlType.ComboBox),
            });

            foreach (var element in window.FindAllDescendants(condition))
            {
                bool enabled;
                try { enabled = element.Properties.IsEnabled.ValueOrDefault; }
                catch { continue; }
                if (!enabled) continue;

                results.Add(Describe(element));
            }
        }
        catch
        {
            // best-effort — see class doc comment.
        }
        return results;
    }

    private static FieldDescriptor Describe(AutomationElement element)
    {
        var automationId = SafeGet(() => element.AutomationId);
        var name = SafeGet(() => element.Name);
        var className = SafeGet(() => element.ClassName);
        var controlType = SafeGet(() => element.ControlType.ToString());
        var bounds = SafeGet(() => element.BoundingRectangle.ToString());
        return new FieldDescriptor(automationId, name, className, controlType, bounds);
    }

    private static string? SafeGet(Func<string?> getter)
    {
        try { return getter(); }
        catch { return null; }
    }

    /// <summary>Compact, single-line-per-field text — NO field values, only
    /// structure — suitable for a single AppFileLog line. "no enabled ...
    /// fields found" when the list is empty (still a useful, explicit
    /// signal — a totally empty screen is a different problem than a
    /// screen with fields that just don't match).</summary>
    public static string DescribeForLog(IReadOnlyList<FieldDescriptor> fields)
    {
        if (fields.Count == 0)
        {
            return "no enabled Edit/Document/ComboBox fields found.";
        }

        return string.Join(" \\ ", fields.Select(f =>
            $"{f.ControlType ?? "<unknown>"} id='{f.AutomationId ?? "<null>"}' name='{f.Name ?? "<null>"}' " +
            $"class='{f.ClassName ?? "<null>"}' bounds={f.Bounds ?? "<unknown>"}"));
    }
}
