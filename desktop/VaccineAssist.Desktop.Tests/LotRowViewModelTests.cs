using System;
using System.Collections.Generic;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// MSG893 item 4 ("Lots screen becomes an editable table with autosave"):
/// LotRowViewModel is the DataGrid row wrapper that makes a Lot editable
/// and drives autosave — see that class's own doc comment for the full
/// design (mirrors VaccineRowViewModel's "commit on set, revert on
/// failure" pattern from the Active vaccines tab, plus an edit-token
/// guard against out-of-order saves). These tests exercise the row in
/// isolation, with no HTTP/LotsViewModel involved — LotsViewModelTests.cs
/// covers the save orchestration.
/// </summary>
public class LotRowViewModelTests
{
    private static Lot MakeLot(string lotNumber = "L1", int expiresInDays = 365, DateOnly? beyondUseDate = null, string? note = null) => new()
    {
        Id = Guid.NewGuid(),
        VaccineId = Guid.NewGuid(),
        LotNumber = lotNumber,
        Expiration = DateOnly.FromDateTime(DateTime.Today.AddDays(expiresInDays)),
        Status = "active",
        BeyondUseDate = beyondUseDate,
        Note = note,
    };

    [Fact]
    public void ConstructorCopiesLotFieldsAndJoinedVaccineInfo()
    {
        var lot = MakeLot("ABC123", note: "shipment 1");
        var row = new LotRowViewModel(lot, "mNEXSPIKE", "00000-0000-01");

        Assert.Equal(lot.Id, row.Id);
        Assert.Equal(lot.VaccineId, row.VaccineId);
        Assert.Equal("mNEXSPIKE", row.VaccineName);
        Assert.Equal("00000-0000-01", row.VaccineNdc);
        Assert.Equal("ABC123", row.LotNumber);
        Assert.Equal(lot.Expiration.ToDateTime(TimeOnly.MinValue), row.Expiration);
        Assert.Null(row.BeyondUseDate);
        Assert.Equal("shipment 1", row.Note);
        Assert.Equal("active", row.Status);
    }

    [Fact]
    public void SettingLotNumberRaisesEditCommittedWithAnIncrementingToken()
    {
        var row = new LotRowViewModel(MakeLot(), "MMR-II", "12345-6789-01");
        var tokens = new List<int>();
        row.EditCommitted += (_, token) => tokens.Add(token);

        row.LotNumber = "NEW1";
        row.Expiration = DateTime.Today.AddYears(2);

        Assert.Equal(new[] { 1, 2 }, tokens);
    }

    [Fact]
    public void SettingToTheSameValueDoesNotRaiseEditCommitted()
    {
        var row = new LotRowViewModel(MakeLot("SAME"), "MMR-II", null);
        var raised = false;
        row.EditCommitted += (_, _) => raised = true;

        row.LotNumber = "SAME";

        Assert.False(raised);
    }

    [Fact]
    public void ExpirationChangeRaisesIsExpiredPropertyChanged()
    {
        var row = new LotRowViewModel(MakeLot(expiresInDays: 365), "MMR-II", null);
        var changed = new List<string?>();
        row.PropertyChanged += (_, e) => changed.Add(e.PropertyName);

        row.Expiration = DateTime.Today.AddDays(-1);

        Assert.Contains(nameof(LotRowViewModel.IsExpired), changed);
        Assert.True(row.IsExpired);
    }

    [Fact]
    public void BeyondUseDateChangeRaisesIsPastBeyondUseDatePropertyChanged()
    {
        var row = new LotRowViewModel(MakeLot(), "MMR-II", null);
        var changed = new List<string?>();
        row.PropertyChanged += (_, e) => changed.Add(e.PropertyName);

        row.BeyondUseDate = DateTime.Today.AddDays(-1);

        Assert.Contains(nameof(LotRowViewModel.IsPastBeyondUseDate), changed);
        Assert.True(row.IsPastBeyondUseDate);
    }

    [Fact]
    public void EditingToAFutureDateClearsIsExpired()
    {
        var row = new LotRowViewModel(MakeLot(expiresInDays: -5), "MMR-II", null);
        Assert.True(row.IsExpired);

        row.Expiration = DateTime.Today.AddYears(1);

        Assert.False(row.IsExpired);
    }

    [Fact]
    public void ApplySaveSuccessClearsSaveErrorAndUpdatesTheRevertPoint()
    {
        var row = new LotRowViewModel(MakeLot("OLD"), "MMR-II", null);
        int? token = null;
        row.EditCommitted += (_, t) => token = t;

        row.LotNumber = "NEW";
        Assert.NotNull(token);

        row.ApplySaveSuccess(token!.Value);

        Assert.Null(row.SaveError);
        Assert.Equal("NEW", row.LotNumber); // unchanged by a success
    }

    [Fact]
    public void ApplySaveFailureRevertsAllEditableFieldsAndSetsSaveError()
    {
        var lot = MakeLot("ORIGINAL", note: "original note");
        var row = new LotRowViewModel(lot, "MMR-II", null);
        int? token = null;
        row.EditCommitted += (_, t) => token = t;

        row.LotNumber = "BROKEN";
        row.Note = "broken note";
        Assert.NotNull(token);

        row.ApplySaveFailure(token!.Value, "network error");

        Assert.Equal("ORIGINAL", row.LotNumber);
        Assert.Equal("original note", row.Note);
        Assert.Equal("network error", row.SaveError);
    }

    [Fact]
    public void RevertingDoesNotReRaiseEditCommitted()
    {
        var row = new LotRowViewModel(MakeLot("ORIGINAL"), "MMR-II", null);
        var raiseCount = 0;
        int lastToken = 0;
        row.EditCommitted += (_, t) => { raiseCount++; lastToken = t; };

        row.LotNumber = "BROKEN";
        Assert.Equal(1, raiseCount);

        row.ApplySaveFailure(lastToken, "failed");

        Assert.Equal(1, raiseCount); // the revert itself must not trigger another save attempt
    }

    [Fact]
    public void AStaleTokenIsIgnoredByApplySaveSuccessAndApplySaveFailure()
    {
        var row = new LotRowViewModel(MakeLot("ORIGINAL"), "MMR-II", null);
        var tokens = new List<int>();
        row.EditCommitted += (_, t) => tokens.Add(t);

        row.LotNumber = "FIRST"; // token 1, save presumed still in flight
        row.LotNumber = "SECOND"; // token 2, supersedes the first edit
        Assert.Equal(new[] { 1, 2 }, tokens);

        // The FIRST (now-stale) save's slow response finally arrives —
        // must be ignored either way, since the newer edit's own PATCH
        // (token 2) already carries the authoritative full snapshot.
        row.ApplySaveFailure(tokens[0], "stale failure");
        Assert.Equal("SECOND", row.LotNumber); // NOT reverted by the stale failure
        Assert.Null(row.SaveError); // stale failure must not surface an error either

        row.ApplySaveSuccess(tokens[1]);
        Assert.Null(row.SaveError);
    }

    [Fact]
    public void CurrentSnapshotReflectsLiveFieldValues()
    {
        var row = new LotRowViewModel(MakeLot("L1"), "MMR-II", null);
        row.LotNumber = "L2";
        row.Note = "a note";
        var bud = DateTime.Today.AddDays(10);
        row.BeyondUseDate = bud;

        var snapshot = row.CurrentSnapshot();

        Assert.Equal("L2", snapshot.LotNumber);
        Assert.Equal("a note", snapshot.Note);
        Assert.Equal(bud, snapshot.BeyondUseDate);
    }
}
