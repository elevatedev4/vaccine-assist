using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-T41 ROUND 6 (Will's 2026-09-29 11:14 app.log): PriorityForegroundWaitPolicy
/// is the pure decision half of WaitForDialogForegroundAndFocus's polling
/// loop — see its own doc comment for the full "why" (the macro-fidelity
/// strategy's old one-shot foreground check refused immediately instead of
/// actively waiting). These cases mirror that method's own contract: type
/// only once BOTH booleans are true, keep waiting while ticks remain, give
/// up once the budget is exhausted.
/// </summary>
public class PriorityForegroundWaitPolicyTests
{
    [Fact]
    public void ForegroundAndFocusedTypesImmediatelyEvenOnFirstTick()
    {
        Assert.Equal(PriorityForegroundWaitDecision.Type,
            PriorityForegroundWaitPolicy.Decide(foregroundIsDialog: true, focusedIsTarget: true, elapsedTicks: 0, maxTicks: 30));
    }

    [Fact]
    public void ForegroundAndFocusedTypesEvenOnTheLastTick()
    {
        // Reaching the budget's edge is never treated as a reason to give
        // up if the condition is ALREADY satisfied that same tick — Type
        // always wins over GiveUp.
        Assert.Equal(PriorityForegroundWaitDecision.Type,
            PriorityForegroundWaitPolicy.Decide(foregroundIsDialog: true, focusedIsTarget: true, elapsedTicks: 30, maxTicks: 30));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public void NotYetSatisfiedKeepsWaitingWhileTicksRemain(bool foregroundIsDialog, bool focusedIsTarget)
    {
        Assert.Equal(PriorityForegroundWaitDecision.KeepWaiting,
            PriorityForegroundWaitPolicy.Decide(foregroundIsDialog, focusedIsTarget, elapsedTicks: 5, maxTicks: 30));
    }

    [Fact]
    public void KeepsWaitingOneTickBeforeTheBudgetRunsOut()
    {
        Assert.Equal(PriorityForegroundWaitDecision.KeepWaiting,
            PriorityForegroundWaitPolicy.Decide(foregroundIsDialog: false, focusedIsTarget: false, elapsedTicks: 29, maxTicks: 30));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public void NotSatisfiedAndBudgetExhaustedGivesUp(bool foregroundIsDialog, bool focusedIsTarget)
    {
        Assert.Equal(PriorityForegroundWaitDecision.GiveUp,
            PriorityForegroundWaitPolicy.Decide(foregroundIsDialog, focusedIsTarget, elapsedTicks: 30, maxTicks: 30));
    }

    [Fact]
    public void PastTheBudgetStillGivesUpRatherThanLoopingForever()
    {
        Assert.Equal(PriorityForegroundWaitDecision.GiveUp,
            PriorityForegroundWaitPolicy.Decide(foregroundIsDialog: false, focusedIsTarget: false, elapsedTicks: 999, maxTicks: 30));
    }
}
