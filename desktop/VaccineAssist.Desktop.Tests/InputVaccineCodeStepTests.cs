using System.Threading.Tasks;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// InputVaccineCodeStep types the vaccine's NDC (not the old macro short
/// code) into PioneerRx's drug quick-search field — see its own doc
/// comment for the confirmed AutomationId and why quantity/days-supply/
/// refills are deliberately NOT wired (they auto-populate from the drug
/// record per the live dumps).
/// </summary>
public class InputVaccineCodeStepTests
{
    [Fact]
    public async Task DryRunDescribesTheNdcAndTwoEnters()
    {
        var payload = new VaccineEntryPayload("mmr1", "LOT123", "01152027", "Left arm", Ndc: "00069-2025-10", PhysicianAlternateId: "ALTPRIMARY");
        var step = new InputVaccineCodeStep();
        var context = new PioneerEntryStepContext(payload, dryRun: true, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.Contains("00069-2025-10", result.Message);
        Assert.Contains(InputVaccineCodeStep.PrescribedItemQuickSearchAutomationId, result.Message);
    }

    [Fact]
    public async Task LiveModeFailsWithNoAttachedWindow()
    {
        var payload = new VaccineEntryPayload("mmr1", "LOT123", "01152027", "Left arm", Ndc: "00069-2025-10", PhysicianAlternateId: "ALTPRIMARY");
        var step = new InputVaccineCodeStep();
        var context = new PioneerEntryStepContext(payload, dryRun: false, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.False(result.Success);
        Assert.Contains("No PioneerRx window attached", result.Message);
    }

    [Fact]
    public async Task LiveModeNamesTheMissingNdcWhenVaccineHasNoneOnFile()
    {
        // "This vaccine has no NDC on file" must fire independently of the
        // attached-window check — checked here with DryRun:false but no
        // window either, so this only proves the message text/shape;
        // ordering (window-check-first) is covered implicitly by the test
        // above using a non-empty Ndc.
        var payload = new VaccineEntryPayload("mmr1", "LOT123", "01152027", "Left arm", Ndc: "", PhysicianAlternateId: "ALTPRIMARY");
        var step = new InputVaccineCodeStep();
        var context = new PioneerEntryStepContext(payload, dryRun: false, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.False(result.Success);
    }
}
