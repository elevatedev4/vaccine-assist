using System.Threading.Tasks;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Safety-critical rewrite (2026-09-05): ConfirmEntryStep no longer types
/// an administration-site code + "w" (the old macro-era placeholder
/// behavior) — no such field was confirmed in the live "Add New Rx"
/// dumps. It now locates PioneerRx's real Save &amp; Continue button
/// (AutomationId 'uxSave') WITHOUT clicking it — see the step's own doc
/// comment for why. These tests cover the dry-run/no-window-attached
/// shapes; actually finding/not-finding the live button needs a real
/// PioneerRx window and can't run here.
/// </summary>
public class ConfirmEntryStepTests
{
    private static readonly VaccineEntryPayload SamplePayload = new("mmr1", "LOT123", "01152027", "Left arm", Ndc: "00069-2025-10", PhysicianAlternateId: "ALTPRIMARY");

    [Fact]
    public async Task DryRunNeverClaimsToClickSaveAndContinue()
    {
        var step = new ConfirmEntryStep();
        var context = new PioneerEntryStepContext(SamplePayload, dryRun: true, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.True(result.DryRun);
        Assert.Contains("without clicking it", result.Message);
        Assert.Contains(ConfirmEntryStep.SaveButtonAutomationId, result.Message);
    }

    [Fact]
    public async Task LiveModeFailsWithNoAttachedWindow()
    {
        var step = new ConfirmEntryStep();
        var context = new PioneerEntryStepContext(SamplePayload, dryRun: false, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.False(result.Success);
        Assert.Contains("No PioneerRx window attached", result.Message);
    }
}
