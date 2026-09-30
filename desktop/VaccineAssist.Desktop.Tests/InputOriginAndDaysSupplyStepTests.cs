using System.Threading.Tasks;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// InputOriginAndDaysSupplyStep (V-T41 R6) sets Origin to "Other" and Days
/// Supply to "1" — see that class's own doc comment for the full design.
/// Only DryRun and no-attached-window are covered here, same as every
/// other field-entry step's tests (InputDirectionsStepTests, etc.): the
/// actual field-search/set/readback path needs a real FlaUI AutomationElement
/// against a live PioneerRx window and isn't independently unit-testable —
/// see OriginAndDaysSupplyFieldCandidatesTests/OriginAndDaysSupplyReadbackTests
/// for the pure logic that path is built from.
/// </summary>
public class InputOriginAndDaysSupplyStepTests
{
    private static VaccineEntryPayload Payload() =>
        new("mmr1", "LOT123", "01152027", "Left arm", Ndc: "00069-2025-10", PhysicianAlternateId: "ALTPRIMARY");

    [Fact]
    public async Task DryRunDescribesBothValuesAndNeverTouchesPioneerRx()
    {
        var step = new InputOriginAndDaysSupplyStep();
        var context = new PioneerEntryStepContext(Payload(), dryRun: true, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.True(result.DryRun);
        Assert.Contains(InputOriginAndDaysSupplyStep.OriginValue, result.Message);
        Assert.Contains(InputOriginAndDaysSupplyStep.DaysSupplyValue, result.Message);
    }

    [Fact]
    public async Task LiveModeFailsWithNoAttachedWindow()
    {
        var step = new InputOriginAndDaysSupplyStep();
        var context = new PioneerEntryStepContext(Payload(), dryRun: false, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.False(result.Success);
        Assert.Contains("No PioneerRx window attached", result.Message);
    }

    [Fact]
    public void Name_IsStableForSequencePlanningTests()
    {
        var step = new InputOriginAndDaysSupplyStep();

        Assert.Equal("Set origin and days supply", step.Name);
    }
}
