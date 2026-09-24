using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-T41 (Will's 2026-09-22 brief, item 6): "Unit tests for the step
/// sequencer (given a fake window, the expected keystroke script per step
/// matches the macro doc), and that missing quantity/directions resolve
/// to defaults." FlaUI's AutomationElement can't actually be faked (it
/// wraps a live COM UIA session — see every other step's own doc comment
/// on why its live branch "can only be proven against a real Pioneer
/// install on Windows"), so — same posture PlaceholderVaccineEntrySequenceTests.cs
/// already established for this exact limitation — "given a fake window"
/// here means DryRun mode, which every step checks FIRST, before ever
/// touching AttachedWindow/FlaUI. These tests assert the dry-run
/// descriptions (the closest thing to a "keystroke script" this codebase
/// can expose without live UIA) name the same macro elements
/// desktop/docs/data-entry-macro.md's side-by-side table does, PLUS
/// PioneerEntrySequenceRunner's new Step-mode single-step runner (V-T41
/// item 5) and Models/VaccineEntryDefaults' quantity/directions
/// resolution (V-T41 item 3).
/// </summary>
public class DataEntryMacroFidelityTests
{
    private static VaccineEntryPayload MakePayload() => new(
        ShortCode: "mmr1",
        LotNumber: "LOT123",
        ExpirationMacroFormat: "01152027",
        AdminSiteDisplayText: "Left arm",
        Ndc: "00069-2025-10",
        PhysicianAlternateId: "ALTPRIMARY",
        Quantity: "0.5 mL",
        Directions: "IM in deltoid",
        VaccineName: "MMR");

    [Fact]
    public async Task DryRunDescriptionNamesThePriorityDialogAndItsVaccineValue()
    {
        // desktop/docs/data-entry-macro.md step 3a: "Priority" dialog is
        // SET to "Vaccine" (a selection, not an Escape) — Will's own
        // confirmation this part already works ("getting 'Vaccine'
        // correctly on the priority"). This is the ONE behavior the brief
        // explicitly says to KEEP, so this test pins its dry-run wording
        // rather than only relying on a live run to prove it didn't
        // regress to a plain Escape.
        var step = new VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps.SendF3AndDismissPreEntryDialogsStep("Vaccine");
        var context = new PioneerEntryStepContext(MakePayload(), dryRun: true, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.Contains("Priority", result.Message);
        Assert.Contains("\"Vaccine\"", result.Message);
        Assert.Contains("Scan Hard Copy", result.Message);
        Assert.Contains("Patient on Cycle Fill", result.Message);
    }

    [Fact]
    public async Task WholeSequenceDryRunMentionsEveryMacroFieldInOrder()
    {
        // Cross-checks the log against desktop/docs/data-entry-macro.md's
        // side-by-side table, in order: prescriber alt ID (step 4), NDC
        // (step 5, NOT the macro's short code — see "Known divergences"),
        // quantity (6), directions (7), lot + expiration (8a/8b).
        var sequence = new PlaceholderVaccineEntrySequence();
        var log = new List<string>();
        var context = new PioneerEntryStepContext(MakePayload(), dryRun: true, log.Add);

        var result = await PioneerEntrySequenceRunner.RunAsync(sequence, context);

        Assert.True(result.Success);
        var joined = string.Join("\n", log);
        var alternateIdIndex = joined.IndexOf("ALTPRIMARY");
        var ndcIndex = joined.IndexOf("00069-2025-10");
        var quantityIndex = joined.IndexOf("0.5 mL");
        var directionsIndex = joined.IndexOf("IM in deltoid");
        var lotIndex = joined.IndexOf("LOT123");

        Assert.True(alternateIdIndex >= 0 && ndcIndex > alternateIdIndex, "prescriber must be entered before the vaccine code");
        Assert.True(ndcIndex >= 0 && quantityIndex > ndcIndex, "vaccine code must be entered before quantity");
        Assert.True(quantityIndex >= 0 && directionsIndex > quantityIndex, "quantity must be entered before directions");
        Assert.True(directionsIndex >= 0 && lotIndex > directionsIndex, "directions must be entered before lot/expiration");
    }

    [Fact]
    public async Task ConfirmEntryStepNeverClicksSaveEvenInDryRunDescription()
    {
        // desktop/docs/data-entry-macro.md step 10: Save is located but
        // never clicked (safety) — pinned here so a future change can't
        // silently flip this without a test failing.
        var step = new VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps.ConfirmEntryStep();
        var context = new PioneerEntryStepContext(MakePayload(), dryRun: true, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.Contains("STOP without clicking it", result.Message);
    }

    // ---- PioneerEntrySequenceRunner.RunSingleStepAsync ("Step mode", V-T41 item 5) ----

    private sealed class FakeStep : IPioneerEntryStep
    {
        private readonly bool _success;
        public FakeStep(string name, bool success = true)
        {
            Name = name;
            _success = success;
        }
        public string Name { get; }
        public Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default) =>
            Task.FromResult(new PioneerEntryStepResult(Name, _success, context.DryRun, _success ? "ok" : "failed on purpose"));
    }

    private sealed class FakeSequence : IPioneerEntrySequence
    {
        public FakeSequence(params IPioneerEntryStep[] steps) => Steps = steps;
        public string Name => "fake";
        public IReadOnlyList<IPioneerEntryStep> Steps { get; }
    }

    [Fact]
    public async Task RunSingleStepAsyncRunsExactlyOneStepAndReportsIndexAndTotal()
    {
        var sequence = new FakeSequence(new FakeStep("one"), new FakeStep("two"), new FakeStep("three"));
        var log = new List<string>();
        var context = new PioneerEntryStepContext(MakePayload(), dryRun: true, log.Add);

        var first = await PioneerEntrySequenceRunner.RunSingleStepAsync(sequence, context, stepIndex: 0);
        Assert.Equal("one", first.Result.StepName);
        Assert.True(first.Result.Success);
        Assert.Equal(0, first.StepIndex);
        Assert.Equal(3, first.TotalSteps);
        Assert.False(first.IsLastStep);

        var last = await PioneerEntrySequenceRunner.RunSingleStepAsync(sequence, context, stepIndex: 2);
        Assert.Equal("three", last.Result.StepName);
        Assert.True(last.IsLastStep);

        // Only the two steps actually run via RunSingleStepAsync appear in
        // the log — "two" (index 1) was never invoked.
        Assert.Contains(log, line => line.Contains("[one]"));
        Assert.DoesNotContain(log, line => line.Contains("[two]"));
        Assert.Contains(log, line => line.Contains("[three]"));
    }

    [Fact]
    public async Task RunSingleStepAsyncReportsFailureWithoutRunningFurtherSteps()
    {
        var sequence = new FakeSequence(new FakeStep("one", success: false), new FakeStep("two"));
        var log = new List<string>();
        var context = new PioneerEntryStepContext(MakePayload(), dryRun: true, log.Add);

        var result = await PioneerEntrySequenceRunner.RunSingleStepAsync(sequence, context, stepIndex: 0);

        Assert.False(result.Result.Success);
        Assert.Contains(log, line => line.Contains("FAILED"));
    }

    [Fact]
    public async Task RunSingleStepAsyncThrowsForAnOutOfRangeIndex()
    {
        var sequence = new FakeSequence(new FakeStep("only"));
        var context = new PioneerEntryStepContext(MakePayload(), dryRun: true, _ => { });

        await Assert.ThrowsAsync<System.ArgumentOutOfRangeException>(
            () => PioneerEntrySequenceRunner.RunSingleStepAsync(sequence, context, stepIndex: 1));
    }

    [Fact]
    public async Task RunAsyncAndRunSingleStepAsyncProduceTheSameShapeOfLogLinesForTheSameStep()
    {
        // Guards the refactor that extracted RunOneStepAsync out of
        // RunAsync (V-T41 item 5) — a Step-mode log line must read the
        // same as the same step's line in a normal full run. Strips the
        // "(took Nms)" suffix before comparing since the two runs measure
        // their own independent (near-instant, but not guaranteed
        // byte-identical) elapsed time.
        var fullLog = new List<string>();
        var fullContext = new PioneerEntryStepContext(MakePayload(), dryRun: true, fullLog.Add);
        await PioneerEntrySequenceRunner.RunAsync(new FakeSequence(new FakeStep("solo")), fullContext);

        var singleLog = new List<string>();
        var singleContext = new PioneerEntryStepContext(MakePayload(), dryRun: true, singleLog.Add);
        await PioneerEntrySequenceRunner.RunSingleStepAsync(new FakeSequence(new FakeStep("solo")), singleContext, 0);

        static string StripTiming(string line) =>
            System.Text.RegularExpressions.Regex.Replace(line, @"\s*\(took \d+ms\)", "");

        Assert.Equal(fullLog.Select(StripTiming), singleLog.Select(StripTiming));
    }

    // ---- Models/VaccineEntryDefaults (quantity/directions defaults, V-T41 item 3) ----

    private static Vaccine MakeVaccine(string? quantity, string? quantityDefault, string? directions, string? directionsDefault) => new()
    {
        Id = System.Guid.NewGuid(),
        Name = "Test Vaccine",
        ShortCode = "test1",
        Active = true,
        Quantity = quantity,
        QuantityDefault = quantityDefault,
        Directions = directions,
        DirectionsDefault = directionsDefault,
    };

    [Fact]
    public void ResolveQuantityPrefersThePerVaccineValueOverTheCatalogDefault()
    {
        var vaccine = MakeVaccine(quantity: "0.5 mL", quantityDefault: "0.3", directions: null, directionsDefault: null);

        var resolution = VaccineEntryDefaults.ResolveQuantity(vaccine);

        Assert.Equal("0.5 mL", resolution.Value);
        Assert.False(resolution.UsedDefault);
    }

    [Fact]
    public void ResolveQuantityFallsBackToTheCatalogDefaultWhenBlank()
    {
        var vaccine = MakeVaccine(quantity: null, quantityDefault: "0.3", directions: null, directionsDefault: null);

        var resolution = VaccineEntryDefaults.ResolveQuantity(vaccine);

        Assert.Equal("0.3", resolution.Value);
        Assert.True(resolution.UsedDefault);
    }

    [Fact]
    public void ResolveQuantityIsNullWhenNeitherIsSet()
    {
        var vaccine = MakeVaccine(quantity: "  ", quantityDefault: null, directions: null, directionsDefault: null);

        var resolution = VaccineEntryDefaults.ResolveQuantity(vaccine);

        Assert.Null(resolution.Value);
        Assert.False(resolution.UsedDefault);
    }

    [Fact]
    public void ResolveDirectionsFallsBackToTheCatalogDefaultWhenBlank()
    {
        var vaccine = MakeVaccine(quantity: null, quantityDefault: null,
            directions: null, directionsDefault: "For administration by healthcare provider in pharmacy.");

        var resolution = VaccineEntryDefaults.ResolveDirections(vaccine);

        Assert.Equal("For administration by healthcare provider in pharmacy.", resolution.Value);
        Assert.True(resolution.UsedDefault);
    }

    [Fact]
    public void ResolveDirectionsPrefersThePerVaccineValueOverTheCatalogDefault()
    {
        var vaccine = MakeVaccine(quantity: null, quantityDefault: null,
            directions: "Custom SIG on file", directionsDefault: "For administration by healthcare provider in pharmacy.");

        var resolution = VaccineEntryDefaults.ResolveDirections(vaccine);

        Assert.Equal("Custom SIG on file", resolution.Value);
        Assert.False(resolution.UsedDefault);
    }
}
