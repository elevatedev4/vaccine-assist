using System.Threading.Tasks;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// InputQuantityStep (NEW, 2026-09-07) types the vaccine's quantity into
/// PioneerRx's Add New Rx quantity field — see its own doc comment for the
/// field target and why this reverses InputVaccineCodeStep's earlier
/// "don't type into uxQuantityPrescribed" decision. NULL quantity (the
/// vaccines.quantity migration hasn't run yet, or is simply unset for this
/// vaccine) must skip cleanly rather than typing a placeholder.
/// </summary>
public class InputQuantityStepTests
{
    private static VaccineEntryPayload PayloadWithQuantity(decimal? quantity) =>
        new("mmr1", "LOT123", "01152027", "Left arm", Ndc: "00069-2025-10", PhysicianAlternateId: "ALTPRIMARY", Quantity: quantity);

    [Fact]
    public async Task NullQuantitySkipsWithoutTypingAnything()
    {
        var step = new InputQuantityStep();
        var context = new PioneerEntryStepContext(PayloadWithQuantity(null), dryRun: false, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.Contains("Skipped", result.Message);
        Assert.Contains("no quantity on file", result.Message);
    }

    [Fact]
    public async Task NullQuantitySkipsEvenInDryRun()
    {
        var step = new InputQuantityStep();
        var context = new PioneerEntryStepContext(PayloadWithQuantity(null), dryRun: true, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.True(result.DryRun);
        Assert.Contains("Skipped", result.Message);
    }

    [Fact]
    public async Task DryRunDescribesTheQuantity()
    {
        var step = new InputQuantityStep();
        var context = new PioneerEntryStepContext(PayloadWithQuantity(0.5m), dryRun: true, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.True(result.DryRun);
        Assert.Contains("0.5", result.Message);
        Assert.Contains(InputQuantityStep.QuantityAutomationId, result.Message);
    }

    [Fact]
    public async Task LiveModeFailsWithNoAttachedWindowWhenAQuantityIsSet()
    {
        var step = new InputQuantityStep();
        var context = new PioneerEntryStepContext(PayloadWithQuantity(0.5m), dryRun: false, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.False(result.Success);
        Assert.Contains("No PioneerRx window attached", result.Message);
    }
}
