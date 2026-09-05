using System;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-... Part C: the data-entry popup's expiration gate. On a vaccine
/// selection, the popup checks that vaccine's current lot in the
/// background (DataEntryPopupViewModel.RefreshSelectedVaccineActiveLotAsync)
/// and blocks "Enter into Pioneer" unless either an unexpired active lot
/// is on file, or staff explicitly chose to proceed without one
/// (SkipLotAndExpirationCommand) — see IsLotExpiredOrMissing.
/// </summary>
public class DataEntryPopupViewModelExpirationGateTests
{
    private static readonly Vaccine SampleVaccine = new() { Id = Guid.NewGuid(), Name = "MMR-II", ShortCode = "mmr1", Dose = "1", Active = true };
    private static readonly Vaccine OtherVaccine = new() { Id = Guid.NewGuid(), Name = "Boostrix", ShortCode = "boostrix", Dose = "1", Active = true };

    private static DataEntryPopupViewModel CreateViewModel(FakeVaccineApiService apiService, IPioneerEntrySequence? sequence = null) =>
        new(apiService, new NoOpClipboardService(), sequence ?? new NoOpPioneerEntrySequence(), pioneerWindowDetected: true);

    private static async Task Settle(DataEntryPopupViewModel viewModel)
    {
        for (var i = 0; i < 50 && viewModel.IsBusy; i++)
        {
            await Task.Delay(10);
        }
        // Covers the fire-and-forget lot-status check the same way
        // DataEntryPopupViewModelAutoValidateTests.WaitForBusyToSettle does
        // — see that method's doc comment.
        await Task.Delay(20);
    }

    [Fact]
    public async Task NoActiveLotOnFileBlocksEnterIntoPioneerEvenWhenEligibilityAllows()
    {
        var apiService = new FakeVaccineApiService(); // LotsByVaccineId left empty -- no lot for SampleVaccine
        var viewModel = CreateViewModel(apiService);

        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);

        Assert.True(viewModel.Gate.CanEnterIntoPioneer); // eligibility itself is fine
        Assert.True(viewModel.IsLotExpiredOrMissing);
        Assert.False(viewModel.EnterIntoPioneerCommand.CanExecute(null));
    }

    [Fact]
    public async Task ExpiredLotOnFileAlsoBlocksEnterIntoPioneer()
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

        Assert.True(viewModel.IsLotExpiredOrMissing);
        Assert.False(viewModel.EnterIntoPioneerCommand.CanExecute(null));
    }

    [Fact]
    public async Task UnexpiredActiveLotClearsTheGateAndAllowsEntry()
    {
        var apiService = new FakeVaccineApiService();
        apiService.LotsByVaccineId[SampleVaccine.Id] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = SampleVaccine.Id, LotNumber = "GOOD1", Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)), Status = "active" },
        };
        var viewModel = CreateViewModel(apiService);

        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);

        Assert.False(viewModel.IsLotExpiredOrMissing);
        Assert.True(viewModel.EnterIntoPioneerCommand.CanExecute(null));
    }

    [Fact]
    public async Task SkipLotAndExpirationCommandUnblocksEnterIntoPioneerWithoutAnyLot()
    {
        var apiService = new FakeVaccineApiService();
        var viewModel = CreateViewModel(apiService);
        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);
        Assert.False(viewModel.EnterIntoPioneerCommand.CanExecute(null));

        Assert.True(viewModel.SkipLotAndExpirationCommand.CanExecute(null));
        viewModel.SkipLotAndExpirationCommand.Execute(null);

        Assert.True(viewModel.SkipLotAndExpiration);
        Assert.True(viewModel.EnterIntoPioneerCommand.CanExecute(null));
    }

    [Fact]
    public async Task SkippingDoesNotCarryOverToADifferentVaccineSelection()
    {
        var apiService = new FakeVaccineApiService();
        var viewModel = CreateViewModel(apiService);
        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);
        viewModel.SkipLotAndExpirationCommand.Execute(null);
        Assert.True(viewModel.SkipLotAndExpiration);

        viewModel.SelectedVaccine = OtherVaccine;
        await Settle(viewModel);

        Assert.False(viewModel.SkipLotAndExpiration);
        Assert.False(viewModel.EnterIntoPioneerCommand.CanExecute(null)); // fresh vaccine, no lot, no skip yet
    }

    [Fact]
    public async Task AddLotCommandRefreshesLotStatusAndClearsTheGate()
    {
        var apiService = new FakeVaccineApiService();
        var viewModel = CreateViewModel(apiService);
        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);
        Assert.True(viewModel.IsLotExpiredOrMissing);

        viewModel.NewLotNumber = "NEW1";
        viewModel.NewLotExpiration = DateTime.Today.AddYears(1);
        Assert.True(viewModel.AddLotCommand.CanExecute(null));
        viewModel.AddLotCommand.Execute(null);
        await Settle(viewModel);

        var created = Assert.Single(apiService.CreatedLots);
        Assert.Equal(SampleVaccine.Id, created.VaccineId);
        Assert.Equal("NEW1", created.LotNumber);
        Assert.False(viewModel.IsLotExpiredOrMissing);
        Assert.True(viewModel.EnterIntoPioneerCommand.CanExecute(null));
        Assert.Equal("", viewModel.NewLotNumber); // form cleared after a successful add
    }

    [Fact]
    public async Task AddingARealLotAfterChoosingSkipClearsTheSkipFlagAndUsesTheRealLot()
    {
        // BLOCKER 1 regression (reviewer request-changes round): repro was
        // "leave blank and proceed" -> flag=true -> staff adds a real lot
        // anyway -> flag never reset -> BuildPayloadAsync still emitted a
        // blank-lot payload even though a valid lot now existed. Covers
        // AddLotAsync's own reset of SkipLotAndExpiration.
        var apiService = new FakeVaccineApiService();
        var sequence = new PayloadCapturingPioneerEntrySequence();
        var viewModel = CreateViewModel(apiService, sequence);
        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);
        viewModel.SkipLotAndExpirationCommand.Execute(null);
        Assert.True(viewModel.SkipLotAndExpiration);

        viewModel.NewLotNumber = "REALLOT2";
        viewModel.NewLotExpiration = DateTime.Today.AddYears(1);
        viewModel.AddLotCommand.Execute(null);
        await Settle(viewModel);

        Assert.False(viewModel.SkipLotAndExpiration); // must not stay stuck true after a real lot is added
        Assert.False(viewModel.IsLotExpiredOrMissing);

        viewModel.EnterIntoPioneerCommand.Execute(null);
        await Settle(viewModel);

        Assert.NotNull(sequence.CapturedPayload);
        Assert.False(sequence.CapturedPayload!.SkipLotAndExpiration);
        Assert.Equal("REALLOT2", sequence.CapturedPayload.LotNumber);
    }

    [Fact]
    public async Task BuildPayloadPrefersARealLotEvenIfSkipFlagIsStaleTrue()
    {
        // BLOCKER 1 regression, second half (defense in depth): even if
        // SkipLotAndExpiration were somehow still true through some path
        // OTHER than AddLotAsync (the one already covered above), building
        // the actual PioneerRx payload must never emit a blank lot once a
        // real, unexpired one exists. Simulated by adding a lot directly
        // to the fake's backing store (bypassing AddLotCommand entirely,
        // so this doesn't rely on AddLotAsync's own reset) WITHOUT ever
        // refreshing the popup's cached SelectedVaccineActiveLot/
        // IsLotExpiredOrMissing — BuildPayloadAsync's own fresh
        // GetLotsAsync call at the moment of entry is what has to catch
        // this, not the (deliberately left stale here) VM state.
        var apiService = new FakeVaccineApiService();
        var sequence = new PayloadCapturingPioneerEntrySequence();
        var viewModel = CreateViewModel(apiService, sequence);
        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);
        viewModel.SkipLotAndExpirationCommand.Execute(null);
        Assert.True(viewModel.SkipLotAndExpiration);

        // A lot appears in the backing store through some path other than
        // AddLotCommand (e.g. another workstation) — the popup's own
        // cached lot state is left stale on purpose here.
        apiService.LotsByVaccineId[SampleVaccine.Id] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = SampleVaccine.Id, LotNumber = "REALLOT", Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)), Status = "active" },
        };

        Assert.True(viewModel.EnterIntoPioneerCommand.CanExecute(null)); // stale skip flag still unblocks the gate itself
        viewModel.EnterIntoPioneerCommand.Execute(null);
        await Settle(viewModel);

        Assert.NotNull(sequence.CapturedPayload);
        Assert.False(sequence.CapturedPayload!.SkipLotAndExpiration); // must NOT be the blank/skip payload
        Assert.Equal("REALLOT", sequence.CapturedPayload.LotNumber);
    }

    [Fact]
    public async Task SkippedLotProducesABlankLotPayloadThatReachesTheSequence()
    {
        var apiService = new FakeVaccineApiService();
        var sequence = new PayloadCapturingPioneerEntrySequence();
        var viewModel = CreateViewModel(apiService, sequence);
        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);
        viewModel.SkipLotAndExpirationCommand.Execute(null);
        Assert.True(viewModel.EnterIntoPioneerCommand.CanExecute(null));

        viewModel.EnterIntoPioneerCommand.Execute(null);
        await Settle(viewModel);

        Assert.NotNull(sequence.CapturedPayload);
        Assert.True(sequence.CapturedPayload!.SkipLotAndExpiration);
        Assert.Equal("", sequence.CapturedPayload.LotNumber);
        Assert.Equal("", sequence.CapturedPayload.ExpirationMacroFormat);
        Assert.Equal(SampleVaccine.ShortCode, sequence.CapturedPayload.ShortCode);
    }
}
