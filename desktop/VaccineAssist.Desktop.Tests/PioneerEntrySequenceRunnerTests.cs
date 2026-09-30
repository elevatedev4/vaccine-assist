using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class PioneerEntrySequenceRunnerTests
{
    private static VaccineEntryPayload SamplePayload => new("mmr1", "LOT123", "01152027", "Left arm");

    private static PioneerEntryStepContext MakeContext(bool dryRun, List<string> log) =>
        new(SamplePayload, dryRun, log.Add);

    [Fact]
    public async Task RunsEveryStepInOrderWhenAllSucceed()
    {
        var log = new List<string>();
        var context = MakeContext(dryRun: false, log);
        var sequence = new FakeSequence(
            new FakeStep("one", success: true),
            new FakeStep("two", success: true),
            new FakeStep("three", success: true));

        var result = await PioneerEntrySequenceRunner.RunAsync(sequence, context);

        Assert.True(result.Success);
        Assert.Equal(3, result.StepResults.Count);
        Assert.Equal(new[] { "one", "two", "three" }, ExecutedStepNames(sequence));
    }

    [Fact]
    public async Task StopsAtTheFirstFailedStepAndDoesNotRunLaterOnes()
    {
        var log = new List<string>();
        var context = MakeContext(dryRun: false, log);
        var sequence = new FakeSequence(
            new FakeStep("one", success: true),
            new FakeStep("two", success: false, message: "no field target"),
            new FakeStep("three", success: true));

        var result = await PioneerEntrySequenceRunner.RunAsync(sequence, context);

        Assert.False(result.Success);
        Assert.Equal(2, result.StepResults.Count); // "three" never ran
        Assert.Equal("two", result.FirstFailure?.StepName);
        Assert.Equal("no field target", result.FirstFailure?.Message);
        Assert.Equal(new[] { "one", "two" }, ExecutedStepNames(sequence));
    }

    [Fact]
    public async Task AnUnexpectedExceptionFromAStepIsCaughtAndTreatedAsFailure()
    {
        var log = new List<string>();
        var context = MakeContext(dryRun: false, log);
        var sequence = new FakeSequence(new ThrowingStep("boom"));

        var result = await PioneerEntrySequenceRunner.RunAsync(sequence, context);

        Assert.False(result.Success);
        Assert.Single(result.StepResults);
        Assert.Contains("boom", result.StepResults[0].Message);
    }

    [Fact]
    public async Task LogsAStartAndFinishLineForEachStepThatRuns()
    {
        var log = new List<string>();
        var context = MakeContext(dryRun: false, log);
        var sequence = new FakeSequence(new FakeStep("only-step", success: true));

        await PioneerEntrySequenceRunner.RunAsync(sequence, context);

        Assert.Contains(log, line => line.Contains("only-step") && line.Contains("starting"));
        Assert.Contains(log, line => line.Contains("only-step") && line.Contains("OK"));
    }

    [Fact]
    public async Task DryRunFlagIsPassedThroughToEveryStep()
    {
        var log = new List<string>();
        var context = MakeContext(dryRun: true, log);
        var step = new FakeStep("checks-dry-run", success: true);
        var sequence = new FakeSequence(step);

        await PioneerEntrySequenceRunner.RunAsync(sequence, context);

        Assert.True(step.ObservedDryRun);
    }

    /// <summary>
    /// V-T41 R5 (Will's brief, item 4 — the Ctrl+Keypad 7 "entry in
    /// progress" overlay's X button cancels the run via a CancellationToken
    /// threaded through PioneerEntrySequenceRunner): cancelling the token
    /// BETWEEN steps (the runner's own cancellationToken.ThrowIfCancellationRequested()
    /// check at the top of each loop iteration — PioneerEntrySequenceRunner.cs)
    /// must stop the run before the next step ever executes. CancelingStep
    /// below simulates "the user clicked X" as a side effect of the
    /// PREVIOUS step finishing, using only the existing IPioneerEntryStep
    /// abstraction (no live UIA needed) — same "fake step, no FlaUI
    /// dependency" pattern as FakeStep/ThrowingStep above.
    /// </summary>
    [Fact]
    public async Task CancellingBetweenStepsStopsTheRunBeforeTheNextStepRuns()
    {
        var log = new List<string>();
        var context = MakeContext(dryRun: false, log);
        using var cts = new CancellationTokenSource();
        var first = new CancelingStep("one", cts);
        var second = new FakeStep("two", success: true);
        var sequence = new FakeSequence(first, second);

        await Assert.ThrowsAsync<System.OperationCanceledException>(
            () => PioneerEntrySequenceRunner.RunAsync(sequence, context, cts.Token));

        Assert.True(first.WasExecuted);
        Assert.False(second.WasExecuted); // never reached -- cancellation was observed before it could start
    }

    /// <summary>
    /// REVIEWER FIX (REQUEST_CHANGES, V-T41 R5): the REALISTIC shape of a
    /// Ctrl+Keypad 7 cancel is the overlay's X firing WHILE a step is
    /// mid-poll (QuickSearchFieldEntry.WaitForFieldAsync/TypeAndConfirmAsync's
    /// own Task.Delay(interval, cancellationToken)) — that throws
    /// OperationCanceledException FROM WITHIN step.ExecuteAsync, not
    /// between steps. Before RunOneStepAsync's dedicated
    /// `catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)`
    /// clause existed, its blanket `catch (Exception ex)` swallowed this
    /// into an ordinary "FAILED — Unexpected error: The operation was
    /// canceled." step result — RunAsync would then return NORMALLY
    /// (Success: false, no exception thrown at all), which this test would
    /// catch: Assert.ThrowsAsync below would fail with "expected
    /// OperationCanceledException, no exception was thrown."
    /// CancelingThrowingStep simulates that exact shape — cancels `cts`
    /// AND throws OperationCanceledException itself, the same way a real
    /// step's own cancelled Task.Delay would.
    /// </summary>
    [Fact]
    public async Task CancellingMidStepThrowsInsteadOfBeingSwallowedAsAFailure()
    {
        var log = new List<string>();
        var context = MakeContext(dryRun: false, log);
        using var cts = new CancellationTokenSource();
        var first = new CancelingThrowingStep("one", cts);
        var second = new FakeStep("two", success: true);
        var sequence = new FakeSequence(first, second);

        await Assert.ThrowsAsync<System.OperationCanceledException>(
            () => PioneerEntrySequenceRunner.RunAsync(sequence, context, cts.Token));

        Assert.True(first.WasExecuted);
        Assert.False(second.WasExecuted); // never reached
        Assert.Contains(log, line => line.Contains("cancelled by user mid-step"));
    }

    private static IEnumerable<string> ExecutedStepNames(FakeSequence sequence)
    {
        foreach (var step in sequence.Steps)
        {
            if (step is FakeStep fake && fake.WasExecuted) yield return fake.Name;
        }
    }

    private sealed class FakeSequence : IPioneerEntrySequence
    {
        public FakeSequence(params IPioneerEntryStep[] steps) => Steps = steps;
        public string Name => "Fake sequence";
        public IReadOnlyList<IPioneerEntryStep> Steps { get; }
    }

    private sealed class FakeStep : IPioneerEntryStep
    {
        private readonly bool _success;
        private readonly string _message;

        public FakeStep(string name, bool success, string message = "ok")
        {
            Name = name;
            _success = success;
            _message = message;
        }

        public string Name { get; }
        public bool WasExecuted { get; private set; }
        public bool ObservedDryRun { get; private set; }

        public Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
        {
            WasExecuted = true;
            ObservedDryRun = context.DryRun;
            return Task.FromResult(new PioneerEntryStepResult(Name, _success, context.DryRun, _message));
        }
    }

    /// <summary>Runs successfully, but cancels `cts` as a side effect —
    /// simulates the overlay's X button firing while the PREVIOUS step was
    /// still the one executing, so the runner's own between-steps
    /// cancellationToken.ThrowIfCancellationRequested() check is what
    /// actually stops the run. See CancellingBetweenStepsStopsTheRunBeforeTheNextStepRuns.</summary>
    private sealed class CancelingStep : IPioneerEntryStep
    {
        private readonly CancellationTokenSource _cts;
        public CancelingStep(string name, CancellationTokenSource cts)
        {
            Name = name;
            _cts = cts;
        }

        public string Name { get; }
        public bool WasExecuted { get; private set; }

        public Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
        {
            WasExecuted = true;
            _cts.Cancel();
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: true, context.DryRun, "ok"));
        }
    }

    /// <summary>Simulates the REAL shape of a mid-step cancel: cancels `cts`
    /// AND throws OperationCanceledException from inside ExecuteAsync
    /// itself (exactly what a real step's own cancelled Task.Delay(...,
    /// cancellationToken) would do) — see
    /// CancellingMidStepThrowsInsteadOfBeingSwallowedAsAFailure.</summary>
    private sealed class CancelingThrowingStep : IPioneerEntryStep
    {
        private readonly CancellationTokenSource _cts;
        public CancelingThrowingStep(string name, CancellationTokenSource cts)
        {
            Name = name;
            _cts = cts;
        }

        public string Name { get; }
        public bool WasExecuted { get; private set; }

        public Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
        {
            WasExecuted = true;
            _cts.Cancel();
            throw new System.OperationCanceledException(cancellationToken);
        }
    }

    private sealed class ThrowingStep : IPioneerEntryStep
    {
        private readonly string _message;
        public ThrowingStep(string message) => _message = message;
        public string Name => "throwing-step";

        public Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
            => throw new System.InvalidOperationException(_message);
    }
}
