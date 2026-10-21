using System.Collections.Generic;
using VaccineAssist.Desktop.Startup;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>Outage 2026-10-20: a frozen instance held the single-instance mutex and every later launch quietly exited.</summary>
public class SingleInstancePolicyTests
{
    private static readonly IReadOnlyList<OtherInstance> None = new List<OtherInstance>();

    private static IReadOnlyList<OtherInstance> One(InstanceHealth health, bool killable = true) =>
        new List<OtherInstance> { new(4242, health, killable) };

    [Fact]
    public void MutexAcquired_RunsNormally_EvenWithOthersListed()
    {
        Assert.Equal(SingleInstanceDecision.RunNormally, SingleInstancePolicy.Decide(true, false, None));
        Assert.Equal(SingleInstanceDecision.RunNormally, SingleInstancePolicy.Decide(true, false, One(InstanceHealth.Hung)));
    }

    [Fact]
    public void HealthyInstanceThatAcknowledged_JustGetsFocused()
    {
        Assert.Equal(SingleInstanceDecision.ActivatedExisting, SingleInstancePolicy.Decide(false, true, None));
        Assert.Equal(SingleInstanceDecision.ActivatedExisting, SingleInstancePolicy.Decide(false, true, One(InstanceHealth.Hung)));
    }

    [Fact]
    public void NoAcknowledgement_AndAFrozenKillableInstance_OffersRecovery()
    {
        Assert.Equal(SingleInstanceDecision.OfferRecovery, SingleInstancePolicy.Decide(false, false, One(InstanceHealth.Hung)));
    }

    [Fact]
    public void FrozenInstanceOfAnotherUserOrSession_IsNeverOffered()
    {
        Assert.Equal(SingleInstanceDecision.ShowAlreadyRunning, SingleInstancePolicy.Decide(false, false, One(InstanceHealth.Hung, killable: false)));
    }

    [Fact]
    public void ResponsiveInstanceWithoutTheListener_IsAnOlderBuildAndIsLeftAlone()
    {
        Assert.Equal(SingleInstanceDecision.ShowAlreadyRunning, SingleInstancePolicy.Decide(false, false, One(InstanceHealth.Responsive)));
    }

    [Fact]
    public void UnknownHealthOrNothingFound_IsNeverKilled()
    {
        Assert.Equal(SingleInstanceDecision.ShowAlreadyRunning, SingleInstancePolicy.Decide(false, false, One(InstanceHealth.Unknown)));
        Assert.Equal(SingleInstanceDecision.ShowAlreadyRunning, SingleInstancePolicy.Decide(false, false, None));
    }

    [Fact]
    public void AFrozenProcessNextToAHealthyOne_IsNotOffered()
    {
        var both = new List<OtherInstance> { new(1, InstanceHealth.Hung, true), new(2, InstanceHealth.Responsive, true) };
        Assert.Equal(SingleInstanceDecision.ShowAlreadyRunning, SingleInstancePolicy.Decide(false, false, both));
    }

    [Fact]
    public void Killable_RequiresSameSessionAndSameUser()
    {
        Assert.True(SingleInstancePolicy.IsKillable(1, 1, "S-1-5-21-1", "s-1-5-21-1"));
        Assert.False(SingleInstancePolicy.IsKillable(1, 2, "S-1-5-21-1", "S-1-5-21-1"));
        Assert.False(SingleInstancePolicy.IsKillable(1, 1, "S-1-5-21-1", "S-1-5-21-2"));
        Assert.False(SingleInstancePolicy.IsKillable(1, 1, null, null));
        Assert.False(SingleInstancePolicy.IsKillable(1, 1, "S-1-5-21-1", null));
    }
}
