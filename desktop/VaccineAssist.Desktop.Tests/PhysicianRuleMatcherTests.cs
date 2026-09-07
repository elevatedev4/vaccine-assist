using System;
using VaccineAssist.Desktop.Models;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// PhysicianRuleMatcher (NEW, 2026-09-07) — pure specific &gt; group &gt;
/// wildcard physician-rule matching precedence. See that class's own doc
/// comment for why it mirrors (rather than replaces) the cloud API's own
/// resolution used at live entry time.
/// </summary>
public class PhysicianRuleMatcherTests
{
    private static readonly Vaccine Comirnaty = new() { Id = Guid.NewGuid(), Name = "Comirnaty 2025-26 12+", ShortCode = "comirnaty" };
    private static readonly Vaccine Boostrix = new() { Id = Guid.NewGuid(), Name = "Boostrix", ShortCode = "boostrix" };

    [Fact]
    public void SpecificVaccineRuleOutranksAGroupRule()
    {
        var specific = new PhysicianRule { Id = Guid.NewGuid(), PhysicianId = Guid.NewGuid(), VaccineId = Comirnaty.Id, Priority = 100 };
        var group = new PhysicianRule { Id = Guid.NewGuid(), PhysicianId = Guid.NewGuid(), VaccineGroup = "COVID", Priority = 0 };

        var resolved = PhysicianRuleMatcher.Resolve(new[] { group, specific }, Comirnaty, ageYears: 40);

        Assert.Equal(specific.Id, resolved?.Id);
    }

    [Fact]
    public void GroupRuleOutranksAWildcardRule()
    {
        var group = new PhysicianRule { Id = Guid.NewGuid(), PhysicianId = Guid.NewGuid(), VaccineGroup = "COVID", Priority = 100 };
        var wildcard = new PhysicianRule { Id = Guid.NewGuid(), PhysicianId = Guid.NewGuid(), Priority = 0 };

        var resolved = PhysicianRuleMatcher.Resolve(new[] { wildcard, group }, Comirnaty, ageYears: 40);

        Assert.Equal(group.Id, resolved?.Id);
    }

    [Fact]
    public void GroupRuleDoesNotMatchAVaccineInADifferentGroup()
    {
        var covidGroupRule = new PhysicianRule { Id = Guid.NewGuid(), PhysicianId = Guid.NewGuid(), VaccineGroup = "COVID" };
        var wildcard = new PhysicianRule { Id = Guid.NewGuid(), PhysicianId = Guid.NewGuid() };

        var resolved = PhysicianRuleMatcher.Resolve(new[] { covidGroupRule, wildcard }, Boostrix, ageYears: 40);

        Assert.Equal(wildcard.Id, resolved?.Id); // Boostrix is Tetanus/whooping cough, not COVID
    }

    [Fact]
    public void GroupMatchIsCaseInsensitive()
    {
        var group = new PhysicianRule { Id = Guid.NewGuid(), PhysicianId = Guid.NewGuid(), VaccineGroup = "covid" };

        var resolved = PhysicianRuleMatcher.Resolve(new[] { group }, Comirnaty, ageYears: 40);

        Assert.Equal(group.Id, resolved?.Id);
    }

    [Fact]
    public void PriorityBreaksTiesWithinTheSameSpecificityTier()
    {
        var lowerPriorityWins = new PhysicianRule { Id = Guid.NewGuid(), PhysicianId = Guid.NewGuid(), VaccineGroup = "COVID", Priority = 1 };
        var higherPriorityLoses = new PhysicianRule { Id = Guid.NewGuid(), PhysicianId = Guid.NewGuid(), VaccineGroup = "COVID", Priority = 5 };

        var resolved = PhysicianRuleMatcher.Resolve(new[] { higherPriorityLoses, lowerPriorityWins }, Comirnaty, ageYears: 40);

        Assert.Equal(lowerPriorityWins.Id, resolved?.Id);
    }

    [Fact]
    public void AgeOutsideRangeExcludesARuleEvenIfItWouldOtherwiseMatch()
    {
        var tooOld = new PhysicianRule { Id = Guid.NewGuid(), PhysicianId = Guid.NewGuid(), VaccineId = Comirnaty.Id, MaxAge = 17 };
        var fallback = new PhysicianRule { Id = Guid.NewGuid(), PhysicianId = Guid.NewGuid() };

        var resolved = PhysicianRuleMatcher.Resolve(new[] { tooOld, fallback }, Comirnaty, ageYears: 40);

        Assert.Equal(fallback.Id, resolved?.Id);
    }

    [Fact]
    public void NoMatchingRuleReturnsNull()
    {
        var tooOld = new PhysicianRule { Id = Guid.NewGuid(), PhysicianId = Guid.NewGuid(), VaccineId = Comirnaty.Id, MaxAge = 17 };

        var resolved = PhysicianRuleMatcher.Resolve(new[] { tooOld }, Comirnaty, ageYears: 40);

        Assert.Null(resolved);
    }
}
