using System.Linq;
using System.Threading.Tasks;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class PlaceholderVaccineEntrySequenceTests
{
    [Fact]
    public void StepsAreInTheOrderVaccineAddNewMxeUsed()
    {
        var sequence = new PlaceholderVaccineEntrySequence();

        var names = sequence.Steps.Select(s => s.Name).ToArray();

        Assert.Equal(
            new[]
            {
                "Focus PioneerRx window",
                "Navigate to vaccine entry fields",
                "Enter vaccine product code",
                "Enter lot and expiration",
                "Confirm entry",
            },
            names);
    }

    [Fact]
    public async Task DryRunSucceedsThroughEveryStepWithNoPioneerRxWindowAvailable()
    {
        // On a machine with no PioneerRx installed at all (this test
        // environment included) — dry run must still complete cleanly,
        // since every step checks context.DryRun before touching UIA.
        var sequence = new PlaceholderVaccineEntrySequence();
        var payload = new VaccineEntryPayload("mmr1", "LOT123", "01152027", "Left arm");
        var log = new System.Collections.Generic.List<string>();
        var context = new PioneerEntryStepContext(payload, dryRun: true, log.Add);

        var result = await PioneerEntrySequenceRunner.RunAsync(sequence, context);

        Assert.True(result.Success);
        Assert.Equal(sequence.Steps.Count, result.StepResults.Count);
        Assert.All(result.StepResults, r => Assert.True(r.DryRun));
        Assert.Contains(log, line => line.Contains("mmr1"));
        Assert.Contains(log, line => line.Contains("LOT123"));
    }

    [Fact]
    public async Task LiveRunStopsAtNavigateStepWithAPendingMacroFileMessage()
    {
        // No live PioneerRx window in CI/dev either way, so
        // FocusPioneerWindowStep itself already fails here — this test
        // documents that the SECOND step (the first field-target
        // placeholder) is what blocks on the .mxe file once a window IS
        // attached, by asserting on the step's own message directly
        // rather than relying on a live attach.
        var navigateStep = new PlaceholderVaccineEntrySequence().Steps
            .Single(s => s.Name == "Navigate to vaccine entry fields");
        var payload = new VaccineEntryPayload("mmr1", "LOT123", "01152027", "Left arm");
        var context = new PioneerEntryStepContext(payload, dryRun: false, _ => { });

        var result = await navigateStep.ExecuteAsync(context);

        Assert.False(result.Success);
        Assert.Contains("PENDING-MACRO-FILE", result.Message);
    }
}
