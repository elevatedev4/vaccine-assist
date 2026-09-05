using System.Linq;
using System.Threading.Tasks;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-... update (2026-09-05): the sequence is now WIRED FOR REAL against
/// live PioneerRx UIA tree dumps (see PlaceholderVaccineEntrySequence.cs
/// and each step's own doc comment) — these tests were rewritten from
/// their PENDING-MACRO-FILE-era versions to match: dry-run assertions now
/// check for NDC/alternate-ID/lot text (the fields real steps actually
/// type) instead of the old macro short code, and the live-run test
/// documents the real "no attached window" failure message each step now
/// returns instead of a generic PENDING-MACRO-FILE stub.
/// </summary>
public class PlaceholderVaccineEntrySequenceTests
{
    [Fact]
    public void StepsAreInTheOrderTheLiveDumpsConfirm()
    {
        var sequence = new PlaceholderVaccineEntrySequence();

        var names = sequence.Steps.Select(s => s.Name).ToArray();

        Assert.Equal(
            new[]
            {
                "Focus PioneerRx window",
                "Select prescriber",
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
        var payload = new VaccineEntryPayload("mmr1", "LOT123", "01152027", "Left arm", Ndc: "00069-2025-10", PhysicianAlternateId: "ALTPRIMARY");
        var log = new System.Collections.Generic.List<string>();
        var context = new PioneerEntryStepContext(payload, dryRun: true, log.Add);

        var result = await PioneerEntrySequenceRunner.RunAsync(sequence, context);

        Assert.True(result.Success);
        Assert.Equal(sequence.Steps.Count, result.StepResults.Count);
        Assert.All(result.StepResults, r => Assert.True(r.DryRun));
        Assert.Contains(log, line => line.Contains("ALTPRIMARY")); // SelectPrescriberStep
        Assert.Contains(log, line => line.Contains("00069-2025-10")); // InputVaccineCodeStep
        Assert.Contains(log, line => line.Contains("LOT123")); // InputLotAndExpirationStep
    }

    [Fact]
    public async Task LiveRunStopsAtSelectPrescriberStepWithNoAttachedWindow()
    {
        // No live PioneerRx window in CI/dev either way, so
        // FocusPioneerWindowStep itself already fails here — this test
        // documents that the SECOND step, run directly with no
        // AttachedWindow (as if FocusPioneerWindowStep never ran), fails
        // with its own specific "no attached window" message rather than
        // the old generic PENDING-MACRO-FILE stub.
        var prescriberStep = new PlaceholderVaccineEntrySequence().Steps
            .Single(s => s.Name == "Select prescriber");
        var payload = new VaccineEntryPayload("mmr1", "LOT123", "01152027", "Left arm", Ndc: "00069-2025-10", PhysicianAlternateId: "ALTPRIMARY");
        var context = new PioneerEntryStepContext(payload, dryRun: false, _ => { });

        var result = await prescriberStep.ExecuteAsync(context);

        Assert.False(result.Success);
        Assert.Contains("No PioneerRx window attached", result.Message);
    }

    [Fact]
    public async Task LiveRunOfWholeSequenceStopsAtFocusStepWithNoPioneerRxRunning()
    {
        // End-to-end: on this (non-Windows/no-PioneerRx) test environment,
        // FocusPioneerWindowStep itself must fail first and the runner
        // must never proceed to SelectPrescriberStep at all.
        var sequence = new PlaceholderVaccineEntrySequence();
        var payload = new VaccineEntryPayload("mmr1", "LOT123", "01152027", "Left arm", Ndc: "00069-2025-10", PhysicianAlternateId: "ALTPRIMARY");
        var context = new PioneerEntryStepContext(payload, dryRun: false, _ => { });

        var result = await PioneerEntrySequenceRunner.RunAsync(sequence, context);

        Assert.False(result.Success);
        Assert.Single(result.StepResults);
        Assert.Equal("Focus PioneerRx window", result.StepResults[0].StepName);
    }
}
