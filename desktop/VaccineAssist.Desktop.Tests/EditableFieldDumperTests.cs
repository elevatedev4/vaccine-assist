using System.Collections.Generic;
using System.Linq;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using VaccineAssist.Desktop.Uia;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// REVIEWER FIX (REQUEST_CHANGES, PHI blocker on V-T41 R5): EditableFieldDumper.
/// DescribeForLog is the ONE thing that reaches AppFileLog (and from there
/// "Copy logs," which hands the whole file to support — see AppFileLog's
/// own NO-PHI note) from InputDirectionsStep's diagnostic dump. Some
/// WinForms/UIA Edit controls fall back to the field's own CONTENT for
/// their accessible Name when no AccessibleName/label association exists —
/// never confirmed against a live PioneerRx capture — so Name must never
/// reach the log, even though DirectionsFieldCandidates.TryMatch still
/// needs it IN MEMORY for keyword matching (FieldDescriptor itself still
/// carries it; only the logged text omits it).
/// </summary>
public class EditableFieldDumperTests
{
    [Fact]
    public void DescribeForLogNeverIncludesTheFieldsName()
    {
        var fields = new List<FieldDescriptor>
        {
            new(AutomationId: "uxSig", Name: "some patient-visible text", ClassName: "WindowsForms10.Edit", ControlType: "Edit", Bounds: "1,2,3,4"),
        };

        var text = EditableFieldDumper.DescribeForLog(fields);

        Assert.Contains("uxSig", text);
        Assert.Contains("WindowsForms10.Edit", text);
        Assert.Contains("Edit", text);
        Assert.Contains("1,2,3,4", text);
        Assert.DoesNotContain("some patient-visible text", text);
        Assert.DoesNotContain("name=", text);
    }

    [Fact]
    public void DescribeForLogReportsAnEmptyListExplicitly()
    {
        var text = EditableFieldDumper.DescribeForLog(new List<FieldDescriptor>());

        Assert.Equal("no enabled Edit/Document/ComboBox fields found.", text);
    }

    [Fact]
    public void DescribeForLogCapsAt40EntriesAndNotesHowManyMoreThereWere()
    {
        var fields = Enumerable.Range(1, 45)
            .Select(i => new FieldDescriptor(AutomationId: $"ux{i}", Name: $"name{i}", ClassName: "Edit", ControlType: "Edit"))
            .ToList();

        var text = EditableFieldDumper.DescribeForLog(fields);

        Assert.Contains("ux1'", text);
        Assert.Contains("ux40'", text);
        Assert.DoesNotContain("ux41'", text);
        Assert.DoesNotContain("ux45'", text);
        Assert.Contains("+5 more, not logged", text);
    }

    [Fact]
    public void DescribeForLogDoesNotAddATrailingNoteWhenAt40OrFewer()
    {
        var fields = Enumerable.Range(1, 40)
            .Select(i => new FieldDescriptor(AutomationId: $"ux{i}", Name: null, ClassName: "Edit", ControlType: "Edit"))
            .ToList();

        var text = EditableFieldDumper.DescribeForLog(fields);

        Assert.DoesNotContain("more, not logged", text);
    }
}
