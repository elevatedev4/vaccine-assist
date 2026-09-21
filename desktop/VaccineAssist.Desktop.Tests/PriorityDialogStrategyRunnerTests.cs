using System;
using System.Collections.Generic;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// PriorityDialogStrategyRunner / SynchronousPoll — V-T41 ROUND 4's pure
/// strategy-sequencing and verification-wait primitives (Will's brief,
/// point 5: "Unit tests for strategy sequencing/verification with fakes
/// (dialog stays open -> next strategy; closes -> stop; ...)"). Live UIA
/// strategies (TryUiaSelectStrategy/TryKeyboardStrategy/VerifyDialogGone in
/// SendF3AndDismissPreEntryDialogsStep) can only be proven against a real
/// PioneerRx install on Windows — same posture as every other live branch
/// in this sequence — so this file covers the ORCHESTRATION logic with
/// fake delegates instead.
/// </summary>
public class PriorityDialogStrategyRunnerTests
{
    private static PriorityStrategyStep Step(string name, PriorityStrategyOutcome outcome) =>
        new(name, () => outcome);

    [Fact]
    public void DialogStaysOpenMovesToTheNextStrategy()
    {
        var calls = new List<string>();
        var strategies = new List<PriorityStrategyStep>
        {
            new("first", () => { calls.Add("first"); return PriorityStrategyOutcome.StillOpen; }),
            new("second", () => { calls.Add("second"); return PriorityStrategyOutcome.StillOpen; }),
        };

        var resolvedBy = PriorityDialogStrategyRunner.Run(strategies, (_, _, _, _) => { });

        Assert.Null(resolvedBy);
        Assert.Equal(new[] { "first", "second" }, calls);
    }

    [Fact]
    public void DialogClosingStopsTheRunAndDoesNotTryLaterStrategies()
    {
        var secondStrategyCalled = false;
        var strategies = new List<PriorityStrategyStep>
        {
            Step("first", PriorityStrategyOutcome.Resolved),
            new("second", () => { secondStrategyCalled = true; return PriorityStrategyOutcome.Resolved; }),
        };

        var resolvedBy = PriorityDialogStrategyRunner.Run(strategies, (_, _, _, _) => { });

        Assert.Equal("first", resolvedBy);
        Assert.False(secondStrategyCalled);
    }

    [Fact]
    public void ResolvesOnTheSecondStrategyAfterTheFirstLeavesItOpen()
    {
        var strategies = new List<PriorityStrategyStep>
        {
            Step("first", PriorityStrategyOutcome.StillOpen),
            Step("second", PriorityStrategyOutcome.Resolved),
        };

        var resolvedBy = PriorityDialogStrategyRunner.Run(strategies, (_, _, _, _) => { });

        Assert.Equal("second", resolvedBy);
    }

    [Fact]
    public void NotFoundAlsoMovesToTheNextStrategy()
    {
        var strategies = new List<PriorityStrategyStep>
        {
            Step("first", PriorityStrategyOutcome.NotFound),
            Step("second", PriorityStrategyOutcome.Resolved),
        };

        Assert.Equal("second", PriorityDialogStrategyRunner.Run(strategies, (_, _, _, _) => { }));
    }

    [Fact]
    public void ReturnsNullWhenEveryStrategyLeavesTheDialogOpen()
    {
        var strategies = new List<PriorityStrategyStep>
        {
            Step("first", PriorityStrategyOutcome.StillOpen),
            Step("second", PriorityStrategyOutcome.NotFound),
        };

        Assert.Null(PriorityDialogStrategyRunner.Run(strategies, (_, _, _, _) => { }));
    }

    [Fact]
    public void ReportsEveryStrategyTriedWithA1BasedIndexTotalCountNameAndOutcome()
    {
        var reported = new List<(int N, int Total, string Name, PriorityStrategyOutcome Outcome)>();
        var strategies = new List<PriorityStrategyStep>
        {
            Step("uia", PriorityStrategyOutcome.StillOpen),
            Step("keyboard", PriorityStrategyOutcome.Resolved),
        };

        PriorityDialogStrategyRunner.Run(strategies, (n, total, name, outcome) => reported.Add((n, total, name, outcome)));

        Assert.Equal(new[]
        {
            (1, 2, "uia", PriorityStrategyOutcome.StillOpen),
            (2, 2, "keyboard", PriorityStrategyOutcome.Resolved),
        }, reported);
    }

    [Fact]
    public void AStrategyThatThrowsIsTreatedAsStillOpenAndTheRunContinues()
    {
        var strategies = new List<PriorityStrategyStep>
        {
            new("throws", () => throw new InvalidOperationException("boom")),
            Step("recovers", PriorityStrategyOutcome.Resolved),
        };
        var reportedOutcomes = new List<PriorityStrategyOutcome>();

        var resolvedBy = PriorityDialogStrategyRunner.Run(strategies, (_, _, _, outcome) => reportedOutcomes.Add(outcome));

        Assert.Equal("recovers", resolvedBy);
        Assert.Equal(new[] { PriorityStrategyOutcome.StillOpen, PriorityStrategyOutcome.Resolved }, reportedOutcomes);
    }

    [Fact]
    public void EmptyStrategyListResolvesNothing()
    {
        Assert.Null(PriorityDialogStrategyRunner.Run(Array.Empty<PriorityStrategyStep>(), (_, _, _, _) => { }));
    }

    // --- SynchronousPoll.WaitUntil ---

    [Fact]
    public void WaitUntilReturnsImmediatelyWhenConditionIsAlreadyTrue()
    {
        var sleepCalls = 0;

        var result = SynchronousPoll.WaitUntil(() => true, maxTicks: 5, () => sleepCalls++);

        Assert.True(result);
        Assert.Equal(0, sleepCalls);
    }

    [Fact]
    public void WaitUntilPollsUntilTheConditionBecomesTrue()
    {
        var callCount = 0;
        bool Condition()
        {
            callCount++;
            return callCount >= 3; // true on the 3rd check
        }
        var sleepCalls = 0;

        var result = SynchronousPoll.WaitUntil(Condition, maxTicks: 10, () => sleepCalls++);

        Assert.True(result);
        Assert.Equal(2, sleepCalls); // slept between checks 1->2 and 2->3, not after the 3rd
    }

    [Fact]
    public void WaitUntilGivesUpAfterMaxTicksWhenConditionNeverBecomesTrue()
    {
        var sleepCalls = 0;

        var result = SynchronousPoll.WaitUntil(() => false, maxTicks: 4, () => sleepCalls++);

        Assert.False(result);
        Assert.Equal(4, sleepCalls);
    }
}
