using System.Threading.Tasks;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using VaccineAssist.Desktop.Uia;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// SendF3AndDismissPreEntryDialogsStep (NEW, 2026-09-07) — the
/// Rx-Profile-to-Add-New-Rx transition (F3, then ESC through the
/// "Priority"/"Scan Hard Copy" dialogs). Covers the PURE parts only (dry
/// run description, the "no attached window" guard clause, and
/// PreEntryDialogTitles.Matches' title-matching logic) — the real
/// FlaUI/UIA calls (sending F3, polling the desktop for a dialog window,
/// re-attaching to "Add New Rx") can only be proven against a real
/// PioneerRx install on Windows, same posture as every other live branch
/// in this sequence (FocusPioneerWindowStep, QuickSearchFieldEntry, etc.).
/// </summary>
public class SendF3AndDismissPreEntryDialogsStepTests
{
    private static VaccineEntryPayload SamplePayload() =>
        new("mmr1", "LOT123", "01152027", "Left arm", Ndc: "00069-2025-10", PhysicianAlternateId: "ALTPRIMARY");

    [Fact]
    public async Task DryRunDescribesF3AndBothDialogsWithoutTouchingPioneerRx()
    {
        var step = new SendF3AndDismissPreEntryDialogsStep();
        var context = new PioneerEntryStepContext(SamplePayload(), dryRun: true, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.True(result.DryRun);
        Assert.Contains("F3", result.Message);
        Assert.Contains("Priority", result.Message);
        Assert.Contains("Scan Hard Copy", result.Message);
        Assert.Null(context.AttachedWindow); // dry run never attaches
    }

    [Fact]
    public async Task LiveModeFailsWithNoAttachedWindow()
    {
        var step = new SendF3AndDismissPreEntryDialogsStep();
        var context = new PioneerEntryStepContext(SamplePayload(), dryRun: false, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.False(result.Success);
        Assert.Contains("No PioneerRx window attached", result.Message);
    }

    [Theory]
    [InlineData("Priority", "Priority", true)]
    [InlineData("priority", "Priority", true)]
    [InlineData("Select Priority", "Priority", true)]
    [InlineData("Scan Hard Copy", "Scan Hard Copy", true)]
    [InlineData("scan hard copy order", "Scan Hard Copy", true)]
    [InlineData("Add New Rx", "Priority", false)]
    [InlineData("Rx Profile", "Scan Hard Copy", false)]
    public void MatchesIsContainsCaseInsensitive(string windowTitle, string dialogTitleSubstring, bool expected)
    {
        Assert.Equal(expected, PreEntryDialogTitles.Matches(windowTitle, dialogTitleSubstring));
    }

    [Fact]
    public void AllListsBothKnownDialogTitles()
    {
        Assert.Equal(new[] { PreEntryDialogTitles.Priority, PreEntryDialogTitles.ScanHardCopy }, PreEntryDialogTitles.All);
    }
}
