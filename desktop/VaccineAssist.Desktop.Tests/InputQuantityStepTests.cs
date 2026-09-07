using System.Threading.Tasks;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// InputQuantityStep (NEW, 2026-09-07; typed as free text in the same
/// day's reviewer request-changes round) types the vaccine's quantity into
/// PioneerRx's Add New Rx quantity field — see its own doc comment for the
/// field target and why this reverses InputVaccineCodeStep's earlier
/// "don't type into uxQuantityPrescribed" decision.
///
/// REVIEWER FIX (2026-09-07): vaccine.quantity is a `text` column, not
/// numeric (supabase/migrations/0009_lots_bud_vaccine_defaults.sql lines
/// 26-30 — Pioneer's own quantity field accepts arbitrary strings like
/// "0.5 mL" or "1 dose IM x1"). This step (and Models.Vaccine.Quantity /
/// VaccineEntryPayload.Quantity) used to be `decimal?`, which would have
/// hard-crashed VaccineApiService.GetVaccinesAsync's JSON deserialization
/// the moment a real, non-numeric quantity string was entered on the
/// cloud /vaccines page — these tests were rewritten from decimal sample
/// values ("0.5m") to realistic free-text ones ("0.5 mL") to match.
///
/// Null/blank quantity (the vaccines.quantity migration hasn't run yet, or
/// is simply unset for this vaccine) must skip cleanly rather than typing
/// a placeholder.
/// </summary>
public class InputQuantityStepTests
{
    private static VaccineEntryPayload PayloadWithQuantity(string? quantity) =>
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
    public async Task BlankQuantityAlsoSkips()
    {
        var step = new InputQuantityStep();
        var context = new PioneerEntryStepContext(PayloadWithQuantity("   "), dryRun: false, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.Contains("Skipped", result.Message);
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
    public async Task DryRunDescribesTheQuantityVerbatim()
    {
        var step = new InputQuantityStep();
        var context = new PioneerEntryStepContext(PayloadWithQuantity("0.5 mL"), dryRun: true, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.True(result.DryRun);
        Assert.Contains("0.5 mL", result.Message);
        Assert.Contains(InputQuantityStep.QuantityAutomationId, result.Message);
    }

    [Fact]
    public async Task DryRunDescribesANonNumericQuantityStringWithoutCrashing()
    {
        // The whole point of the reviewer fix: a real-world Pioneer
        // quantity value like this must not be parsed/rejected as a number.
        var step = new InputQuantityStep();
        var context = new PioneerEntryStepContext(PayloadWithQuantity("1 dose IM x1"), dryRun: true, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.Contains("1 dose IM x1", result.Message);
    }

    [Fact]
    public async Task LiveModeFailsWithNoAttachedWindowWhenAQuantityIsSet()
    {
        var step = new InputQuantityStep();
        var context = new PioneerEntryStepContext(PayloadWithQuantity("0.5 mL"), dryRun: false, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.False(result.Success);
        Assert.Contains("No PioneerRx window attached", result.Message);
    }
}
