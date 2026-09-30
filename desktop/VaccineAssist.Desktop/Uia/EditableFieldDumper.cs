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
///
/// REVIEWER FIX (REQUEST_CHANGES, PHI blocker): Collect() still captures
/// each field's Name (FieldDescriptor) since DirectionsFieldCandidates.
/// TryMatch's keyword fallback needs it IN MEMORY to match "Sig"/
/// "Directions" labels — but DescribeForLog, the one method whose output
/// actually reaches AppFileLog (and from there "Copy logs," which hands
/// the whole file to support — see AppFileLog's own NO-PHI note), now
/// deliberately OMITS Name entirely. WinForms/UIA has known cases where an
/// Edit control's accessible Name falls back to the field's own CONTENT
/// when no AccessibleName/label association exists — never confirmed
/// against a live PioneerRx capture, so this dump must not risk it. Only
/// AutomationId, ClassName, ControlType, and bounds are ever written to
/// the log. Also caps the logged list at <see cref="MaxLoggedFields"/>
/// entries — the Add New Rx screen is a small form, not a data grid, so a
/// screen with more enabled fields than that is almost certainly the
/// wrong one to be dumping anyway.
/// </summary>
public static class EditableFieldDumper
{
    /// <summary>See class doc comment's REVIEWER FIX note.</summary>
    private const int MaxLoggedFields = 40;

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

    /// <summary>
    /// Compact, single-line-per-field text for a single AppFileLog line —
    /// "no enabled ... fields found" when the list is empty (still a
    /// useful, explicit signal — a totally empty screen is a different
    /// problem than a screen with fields that just don't match).
    ///
    /// PHI: deliberately NEVER includes Name (see class doc comment's
    /// REVIEWER FIX note) — only AutomationId/ClassName/ControlType/
    /// bounds, none of which can carry a field's typed content. Capped at
    /// MaxLoggedFields entries, with a trailing "(+N more, not logged)"
    /// note when the real count is higher.
    /// </summary>
    public static string DescribeForLog(IReadOnlyList<FieldDescriptor> fields)
    {
        if (fields.Count == 0)
        {
            return "no enabled Edit/Document/ComboBox fields found.";
        }

        var shown = fields.Take(MaxLoggedFields).Select(f =>
            $"{f.ControlType ?? "<unknown>"} id='{f.AutomationId ?? "<null>"}' " +
            $"class='{f.ClassName ?? "<null>"}' bounds={f.Bounds ?? "<unknown>"}");

        var text = string.Join(" \\ ", shown);
        var remaining = fields.Count - MaxLoggedFields;
        return remaining > 0 ? $"{text} \\ (+{remaining} more, not logged)" : text;
    }
}
