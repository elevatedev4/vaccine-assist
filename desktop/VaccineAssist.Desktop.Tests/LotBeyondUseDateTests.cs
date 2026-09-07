using System;
using VaccineAssist.Desktop.Models;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>Pure Lot.IsPastBeyondUseDate logic (NEW, 2026-09-07) — see
/// Models/Lot.cs's own doc comment.</summary>
public class LotBeyondUseDateTests
{
    private static Lot MakeLot(DateOnly? beyondUseDate) => new()
    {
        Id = Guid.NewGuid(),
        VaccineId = Guid.NewGuid(),
        LotNumber = "L1",
        Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)),
        Status = "active",
        BeyondUseDate = beyondUseDate,
    };

    [Fact]
    public void NullBeyondUseDateIsNotPastBud()
    {
        Assert.False(MakeLot(null).IsPastBeyondUseDate);
    }

    [Fact]
    public void FutureBeyondUseDateIsNotPastBud()
    {
        var lot = MakeLot(DateOnly.FromDateTime(DateTime.Today.AddDays(10)));
        Assert.False(lot.IsPastBeyondUseDate);
    }

    [Fact]
    public void TodayIsPastBud()
    {
        var lot = MakeLot(DateOnly.FromDateTime(DateTime.Today));
        Assert.True(lot.IsPastBeyondUseDate);
    }

    [Fact]
    public void YesterdayIsPastBud()
    {
        var lot = MakeLot(DateOnly.FromDateTime(DateTime.Today.AddDays(-1)));
        Assert.True(lot.IsPastBeyondUseDate);
    }

    [Fact]
    public void PastBudDoesNotRequireTheLotItselfToBeExpired()
    {
        // A lot can be past its beyond-use date well before its printed
        // expiration — the two are independent gates (Will, 2026-09-07:
        // "expired OR past its beyond-use date").
        var lot = MakeLot(DateOnly.FromDateTime(DateTime.Today.AddDays(-1)));
        Assert.False(lot.IsExpired);
        Assert.True(lot.IsPastBeyondUseDate);
    }
}
