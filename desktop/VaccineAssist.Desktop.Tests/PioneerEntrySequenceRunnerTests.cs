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

    private sealed class ThrowingStep : IPioneerEntryStep
    {
        private readonly string _message;
        public ThrowingStep(string message) => _message = message;
        public string Name => "throwing-step";

        public Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
            => throw new System.InvalidOperationException(_message);
    }
}
