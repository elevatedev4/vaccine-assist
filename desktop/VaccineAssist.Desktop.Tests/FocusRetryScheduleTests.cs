using System;
using VaccineAssist.Desktop.Views;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// FocusRetrySchedule itself needs no WPF Window (it's a plain static
/// readonly list), so it's covered here by fast xUnit tests instead of
/// only a manual trace — same "pure half" split as AgePromptInputTests
/// vs. AgePromptWindow (which does need a real Window/DispatcherTimer and
/// isn't unit-tested). See AgePromptWindow's own doc comment (V-T41 R6)
/// for how this schedule is used.
/// </summary>
public class FocusRetryScheduleTests
{
    [Fact]
    public void Delays_HasFourEntries()
    {
        Assert.Equal(4, FocusRetrySchedule.Delays.Count);
    }

    [Fact]
    public void Delays_MatchTheBriefedSchedule()
    {
        Assert.Equal(TimeSpan.FromMilliseconds(50), FocusRetrySchedule.Delays[0]);
        Assert.Equal(TimeSpan.FromMilliseconds(150), FocusRetrySchedule.Delays[1]);
        Assert.Equal(TimeSpan.FromMilliseconds(400), FocusRetrySchedule.Delays[2]);
        Assert.Equal(TimeSpan.FromMilliseconds(800), FocusRetrySchedule.Delays[3]);
    }

    [Fact]
    public void Delays_AreStrictlyIncreasing()
    {
        for (var i = 1; i < FocusRetrySchedule.Delays.Count; i++)
        {
            Assert.True(
                FocusRetrySchedule.Delays[i] > FocusRetrySchedule.Delays[i - 1],
                $"Delays[{i}] ({FocusRetrySchedule.Delays[i]}) should be greater than Delays[{i - 1}] ({FocusRetrySchedule.Delays[i - 1]}).");
        }
    }

    [Fact]
    public void Delays_AreAllPositive()
    {
        foreach (var delay in FocusRetrySchedule.Delays)
        {
            Assert.True(delay > TimeSpan.Zero);
        }
    }
}
