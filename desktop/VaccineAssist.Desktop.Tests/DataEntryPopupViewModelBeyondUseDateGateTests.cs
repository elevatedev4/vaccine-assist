using System;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// 2026-09-07 extension of the expiration gate (see
/// DataEntryPopupViewModelExpirationGateTests.cs): entry must also HALT
/// when the active lot is past its beyond-use date, even if it isn't
/// technically expired yet — Will's brief, verbatim: "entry must HALT when
/// the chosen vaccine's lot is expired OR past its beyond-use date —
/// prompt the user to update it in place AND alert them to tell the
/// pharmacist to update the VAR."
/// </summary>
public class DataEntryPopupViewModelBeyondUseDateGateTests
{
    private static readonly Vaccine SampleVaccine = new() { Id = Guid.NewGuid(), Name = "MMR-II", ShortCode = "mmr1", Dose = "1", Active = true };

    private static DataEntryPopupViewModel CreateViewModel(FakeVaccineApiService apiService, IPioneerEntrySequence? sequence = null) =>
        new(apiService, new NoOpClipboardService(), sequence ?? new NoOpPioneerEntrySequence(), pioneerWindowDetected: true);

    private static async Task Settle(DataEntryPopupViewModel viewModel)
    {
        for (var i = 0; i < 50 && viewModel.IsBusy; i++)
        {
            await Task.Delay(10);
        }
        await Task.Delay(20);
    }

    [Fact]
    public async Task LotPastBeyondUseDateBlocksEnterIntoPioneerEvenWhenNotExpired()
    {
        var apiService = new FakeVaccineApiService();
        apiService.LotsByVaccineId[SampleVaccine.Id] = new()
        {
            new Lot
            {
                Id = Guid.NewGuid(), VaccineId = SampleVaccine.Id, LotNumber = "BUD1", Status = "active",
                Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)), // not expired
                BeyondUseDate = DateOnly.FromDateTime(DateTime.Today.AddDays(-1)), // but past BUD
            },
        };
        var viewModel = CreateViewModel(apiService);

        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);

        Assert.True(viewModel.IsLotExpiredOrMissing);
        Assert.False(viewModel.EnterIntoPioneerCommand.CanExecute(null));
        Assert.Contains("beyond-use date", viewModel.LotGateMessage);
        Assert.Contains("pharmacist to update the VAR", viewModel.LotGateMessage);
    }

    [Fact]
    public async Task ExpiredLotMessageAlsoMentionsTheVar()
    {
        var apiService = new FakeVaccineApiService();
        apiService.LotsByVaccineId[SampleVaccine.Id] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = SampleVaccine.Id, LotNumber = "OLD1", Expiration = DateOnly.FromDateTime(DateTime.Today.AddDays(-5)), Status = "active" },
        };
        var viewModel = CreateViewModel(apiService);

        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);

        Assert.Contains("EXPIRED", viewModel.LotGateMessage);
        Assert.Contains("pharmacist to update the VAR", viewModel.LotGateMessage);
    }

    [Fact]
    public async Task NoLotOnFileMessageDoesNotMentionTheVar()
    {
        // A lot that was never entered has no VAR entry yet to update —
        // that instruction is specific to the "was fine, now isn't" cases.
        var apiService = new FakeVaccineApiService();
        var viewModel = CreateViewModel(apiService);

        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);

        Assert.DoesNotContain("VAR", viewModel.LotGateMessage);
    }

    [Fact]
    public async Task UnexpiredLotWellBeforeItsBeyondUseDateClearsTheGate()
    {
        var apiService = new FakeVaccineApiService();
        apiService.LotsByVaccineId[SampleVaccine.Id] = new()
        {
            new Lot
            {
                Id = Guid.NewGuid(), VaccineId = SampleVaccine.Id, LotNumber = "GOOD1", Status = "active",
                Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)),
                BeyondUseDate = DateOnly.FromDateTime(DateTime.Today.AddDays(30)),
            },
        };
        var viewModel = CreateViewModel(apiService);

        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);

        Assert.False(viewModel.IsLotExpiredOrMissing);
        Assert.True(viewModel.EnterIntoPioneerCommand.CanExecute(null));
        Assert.Equal("", viewModel.LotGateMessage);
    }

    [Fact]
    public async Task BuildPayloadSkipsALotThatIsPastBeyondUseDateEvenIfItExpiresEarliest()
    {
        // FEFO must not hand back a BUD-past lot just because it isn't
        // technically expired yet and happens to expire earliest —
        // BuildPayloadAsync's own filter, not just the VM-level gate
        // (which SkipLotAndExpirationCommand bypasses here on purpose so
        // the payload build itself is what's under test).
        var apiService = new FakeVaccineApiService();
        var sequence = new PayloadCapturingPioneerEntrySequence();
        apiService.LotsByVaccineId[SampleVaccine.Id] = new()
        {
            new Lot
            {
                Id = Guid.NewGuid(), VaccineId = SampleVaccine.Id, LotNumber = "BUDPAST", Status = "active",
                Expiration = DateOnly.FromDateTime(DateTime.Today.AddDays(5)),
                BeyondUseDate = DateOnly.FromDateTime(DateTime.Today.AddDays(-1)),
            },
            new Lot
            {
                Id = Guid.NewGuid(), VaccineId = SampleVaccine.Id, LotNumber = "GOODLATER", Status = "active",
                Expiration = DateOnly.FromDateTime(DateTime.Today.AddDays(60)),
                BeyondUseDate = DateOnly.FromDateTime(DateTime.Today.AddDays(30)),
            },
        };
        var viewModel = CreateViewModel(apiService, sequence);
        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);
        Assert.True(viewModel.IsLotExpiredOrMissing); // earliest-expiration lot (BUDPAST) is past BUD

        // V-T21 item 6: SelectedVaccineActiveLot (BUDPAST) is itself past
        // its beyond-use date, so the modal VAR-update confirmation gate
        // applies here too — not what THIS test is about (FEFO lot
        // selection in BuildPayloadAsync), so just confirm it.
        viewModel.ConfirmVarUpdateRequested = _ => true;
        viewModel.SkipLotAndExpirationCommand.Execute(null);
        viewModel.EnterIntoPioneerCommand.Execute(null);
        await Settle(viewModel);

        Assert.NotNull(sequence.CapturedPayload);
        Assert.False(sequence.CapturedPayload!.SkipLotAndExpiration); // GOODLATER was found, so skip never applied
        Assert.Equal("GOODLATER", sequence.CapturedPayload.LotNumber);
    }
}
