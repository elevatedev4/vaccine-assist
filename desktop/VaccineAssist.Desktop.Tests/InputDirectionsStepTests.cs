using System.Threading.Tasks;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// InputDirectionsStep (NEW, 2026-09-07) types the vaccine's directions
/// into a PLACEHOLDER AutomationId — see its own doc comment for why this
/// hasn't been confirmed against a live UIA dump yet. Null/blank
/// directions (the vaccines.directions migration hasn't run yet, or is
/// simply unset for this vaccine) must skip cleanly rather than typing a
/// placeholder value.
/// </summary>
public class InputDirectionsStepTests
{
    private static VaccineEntryPayload PayloadWithDirections(string? directions) =>
        new("mmr1", "LOT123", "01152027", "Left arm", Ndc: "00069-2025-10", PhysicianAlternateId: "ALTPRIMARY", Directions: directions);

    [Fact]
    public async Task NullDirectionsSkipsWithoutTypingAnything()
    {
        var step = new InputDirectionsStep();
        var context = new PioneerEntryStepContext(PayloadWithDirections(null), dryRun: false, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.Contains("Skipped", result.Message);
        Assert.Contains("no directions on file", result.Message);
    }

    [Fact]
    public async Task BlankDirectionsAlsoSkips()
    {
        var step = new InputDirectionsStep();
        var context = new PioneerEntryStepContext(PayloadWithDirections("   "), dryRun: false, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.Contains("Skipped", result.Message);
    }

    [Fact]
    public async Task DryRunDescribesTheDirections()
    {
        var step = new InputDirectionsStep();
        var context = new PioneerEntryStepContext(PayloadWithDirections("IM in deltoid"), dryRun: true, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.True(result.DryRun);
        Assert.Contains("IM in deltoid", result.Message);
        Assert.Contains(InputDirectionsStep.DirectionsAutomationId, result.Message);
    }

    [Fact]
    public async Task LiveModeFailsWithNoAttachedWindowWhenDirectionsAreSet()
    {
        var step = new InputDirectionsStep();
        var context = new PioneerEntryStepContext(PayloadWithDirections("IM in deltoid"), dryRun: false, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.False(result.Success);
        Assert.Contains("No PioneerRx window attached", result.Message);
    }
}
