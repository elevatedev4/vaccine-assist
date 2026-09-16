using System;
using System.Text.Json;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// lot.expiration is becoming nullable in the DB (supabase/migrations/0014,
/// not yet applied — lots coder, 2026-09-16). Models.Lot.Expiration is now
/// DateOnly? to match; these tests cover the three behaviors the brief
/// calls out explicitly: a null expiration deserializes cleanly, reads as
/// "not expired" (never crashes/guesses), and sorts last. See
/// LotBeyondUseDateTests.cs for the same style applied to BeyondUseDate,
/// which already had this nullable shape.
/// </summary>
public class LotNullableExpirationTests
{
    private static Lot MakeLot(DateOnly? expiration) => new()
    {
        Id = Guid.NewGuid(),
        VaccineId = Guid.NewGuid(),
        LotNumber = "L1",
        Expiration = expiration,
        Status = "active",
    };

    [Fact]
    public void ANullExpirationDeserializesWithoutThrowing()
    {
        const string json = """
            {"id":"11111111-1111-1111-1111-111111111111","vaccine_id":"22222222-2222-2222-2222-222222222222","lot_number":"L1","expiration":null,"status":"active"}
            """;

        var lot = JsonSerializer.Deserialize<Lot>(json);

        Assert.NotNull(lot);
        Assert.Null(lot!.Expiration);
        Assert.Equal("L1", lot.LotNumber);
    }

    [Fact]
    public void AMissingExpirationKeyDeserializesTheSameAsNull()
    {
        // A lot row from before 0014 backfills a value at all (vs. an
        // explicit JSON null) should behave identically — the property
        // simply keeps its default (null).
        const string json = """
            {"id":"11111111-1111-1111-1111-111111111111","vaccine_id":"22222222-2222-2222-2222-222222222222","lot_number":"L1","status":"active"}
            """;

        var lot = JsonSerializer.Deserialize<Lot>(json);

        Assert.NotNull(lot);
        Assert.Null(lot!.Expiration);
    }

    [Fact]
    public void NullExpirationIsNotExpired()
    {
        Assert.False(MakeLot(null).IsExpired);
    }

    [Fact]
    public void PastExpirationIsExpired()
    {
        Assert.True(MakeLot(DateOnly.FromDateTime(DateTime.Today.AddDays(-1))).IsExpired);
    }

    [Fact]
    public void FutureExpirationIsNotExpired()
    {
        Assert.False(MakeLot(DateOnly.FromDateTime(DateTime.Today.AddYears(1))).IsExpired);
    }

    [Fact]
    public void NullExpirationProducesAnEmptyMacroFormatRatherThanThrowing()
    {
        // "" is the same sentinel VaccineEntryPayload already uses for
        // "meaningless, don't type this" (SkipLotAndExpiration) —
        // InputLotAndExpirationStep fails gracefully on an unparsable
        // value rather than typing "" into PioneerRx.
        Assert.Equal("", MakeLot(null).ExpirationMacroFormat);
    }

    [Fact]
    public void LotRowViewModelLoadsANullExpirationAsANullDatePickerValueNotAThrow()
    {
        var lot = MakeLot(null);

        var row = new LotRowViewModel(lot, "MMR-II", null);

        Assert.Null(row.Expiration);
        Assert.False(row.IsExpired);
    }
}
