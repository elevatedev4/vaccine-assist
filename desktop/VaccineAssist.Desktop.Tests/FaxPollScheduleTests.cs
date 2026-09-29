using System;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>V-T65 R5 (Will, verbatim, 2026-09-29): "it still shows status
/// 'InProcess' in the app. Need to make sure this stuff updates." Pure
/// DateTime math — see FaxPollSchedule's own doc comment for the
/// 15s/60s/2h schedule.</summary>
public class FaxPollScheduleTests
{
    private static readonly DateTime Queued = new(2026, 9, 29, 10, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void NeverCheckedIsDueImmediately()
    {
        Assert.True(FaxPollSchedule.IsDue(Queued, lastCheckedAtUtc: null, nowUtc: Queued));
    }

    [Fact]
    public void UnderFiveMinutesOldIsNotDueBeforeFifteenSeconds()
    {
        var lastChecked = Queued.AddMinutes(1);
        var now = lastChecked.AddSeconds(14);

        Assert.False(FaxPollSchedule.IsDue(Queued, lastChecked, now));
    }

    [Fact]
    public void UnderFiveMinutesOldIsDueAtFifteenSeconds()
    {
        var lastChecked = Queued.AddMinutes(1);
        var now = lastChecked.AddSeconds(15);

        Assert.True(FaxPollSchedule.IsDue(Queued, lastChecked, now));
    }

    [Fact]
    public void PastFiveMinutesOldIsNotDueBeforeSixtySeconds()
    {
        var lastChecked = Queued.AddMinutes(6);
        var now = lastChecked.AddSeconds(59);

        Assert.False(FaxPollSchedule.IsDue(Queued, lastChecked, now));
    }

    [Fact]
    public void PastFiveMinutesOldIsDueAtSixtySeconds()
    {
        var lastChecked = Queued.AddMinutes(6);
        var now = lastChecked.AddSeconds(60);

        Assert.True(FaxPollSchedule.IsDue(Queued, lastChecked, now));
    }

    [Fact]
    public void RightAtTheFiveMinuteBoundaryUsesTheSlowerInterval()
    {
        // age == BackoffAfter exactly -> the SLOW (60s) interval, not fast.
        var lastChecked = Queued.AddMinutes(5);
        var now = lastChecked.AddSeconds(15);

        Assert.False(FaxPollSchedule.IsDue(Queued, lastChecked, now));
    }

    [Fact]
    public void HasNotExpiredBeforeTwoHours()
    {
        Assert.False(FaxPollSchedule.HasExpired(Queued, Queued.AddHours(2).AddSeconds(-1)));
    }

    [Fact]
    public void HasExpiredAtTwoHours()
    {
        Assert.True(FaxPollSchedule.HasExpired(Queued, Queued.AddHours(2)));
    }
}
