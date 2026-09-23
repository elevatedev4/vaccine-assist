using System;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class FaxScheduleDecisionTests
{
    [Fact]
    public void ParsesAValidHhMmTime()
    {
        Assert.Equal(new TimeOnly(18, 30), FaxScheduleDecision.ParseRunTime("18:30"));
        Assert.Equal(new TimeOnly(6, 5), FaxScheduleDecision.ParseRunTime("06:05"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not-a-time")]
    [InlineData("25:99")]
    public void UnparsableTimeFallsBackToDefault(string? configured)
    {
        Assert.Equal(new TimeOnly(18, 30), FaxScheduleDecision.ParseRunTime(configured));
    }

    [Fact]
    public void FiresWhenClockHasReachedRunTimeAndHasNotRunToday()
    {
        var runTime = new TimeOnly(18, 30);
        var now = new DateTime(2026, 9, 22, 18, 31, 0);

        Assert.True(FaxScheduleDecision.ShouldRunNow(runTime, lastRunLocalDate: null, now));
    }

    [Fact]
    public void DoesNotFireBeforeRunTime()
    {
        var runTime = new TimeOnly(18, 30);
        var now = new DateTime(2026, 9, 22, 18, 29, 0);

        Assert.False(FaxScheduleDecision.ShouldRunNow(runTime, lastRunLocalDate: null, now));
    }

    [Fact]
    public void DoesNotFireTwiceOnTheSameDay()
    {
        var runTime = new TimeOnly(18, 30);
        var now = new DateTime(2026, 9, 22, 20, 0, 0);
        var lastRun = new DateOnly(2026, 9, 22);

        Assert.False(FaxScheduleDecision.ShouldRunNow(runTime, lastRun, now));
    }

    [Fact]
    public void FiresAgainOnANewDayAfterRunTime()
    {
        var runTime = new TimeOnly(18, 30);
        var now = new DateTime(2026, 9, 23, 18, 45, 0);
        var lastRun = new DateOnly(2026, 9, 22);

        Assert.True(FaxScheduleDecision.ShouldRunNow(runTime, lastRun, now));
    }
}
