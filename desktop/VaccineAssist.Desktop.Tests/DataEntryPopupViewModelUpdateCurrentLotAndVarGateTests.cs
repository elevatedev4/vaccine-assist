using System;
using System.Linq;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-T21 items 5 and 6 (Will, 2026-09-08):
///   5. The expiration gate's "skip" BUTTON becomes two CHECKBOXES —
///      "Update current lots to this lot" (UpdateCurrentLotToThis: on
///      proceed, saves the typed lot as this vaccine's current lot AND
///      deletes every other lot on file for it) and "Leave lot/expiration
///      blank and proceed" (SkipLotAndExpiration, now a plain public
///      settable property instead of only a command target — same
///      semantics as before). The two are mutually exclusive.
///   6. The pharmacist-update-VAR message becomes a real modal
///      confirmation gate (RequiresVarUpdateConfirmation /
///      ConfirmVarUpdateRequested) instead of just inline text — entry
///      cannot proceed past an expired/BUD-past lot without an
///      affirmative response.
/// </summary>
public class DataEntryPopupViewModelUpdateCurrentLotAndVarGateTests
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

    // --- Mutual exclusion (item 5) ---

    [Fact]
    public void CheckingUpdateCurrentLotToThisUnchecksSkipLotAndExpiration()
    {
        var viewModel = CreateViewModel(new FakeVaccineApiService());
        viewModel.SkipLotAndExpiration = true;

        viewModel.UpdateCurrentLotToThis = true;

        Assert.True(viewModel.UpdateCurrentLotToThis);
        Assert.False(viewModel.SkipLotAndExpiration);
    }

    [Fact]
    public void CheckingSkipLotAndExpirationUnchecksUpdateCurrentLotToThis()
    {
        var viewModel = CreateViewModel(new FakeVaccineApiService());
        viewModel.UpdateCurrentLotToThis = true;

        viewModel.SkipLotAndExpiration = true;

        Assert.True(viewModel.SkipLotAndExpiration);
        Assert.False(viewModel.UpdateCurrentLotToThis);
    }

    [Fact]
    public async Task BothCheckboxesResetToFalseOnANewVaccineSelection()
    {
        var apiService = new FakeVaccineApiService();
        var viewModel = CreateViewModel(apiService);
        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);
        viewModel.UpdateCurrentLotToThis = true;
        viewModel.NewLotNumber = "SOMELOT";

        viewModel.SelectedVaccine = new Vaccine { Id = Guid.NewGuid(), Name = "Boostrix", ShortCode = "boostrix", Active = true };
        await Settle(viewModel);

        Assert.False(viewModel.UpdateCurrentLotToThis);
        Assert.False(viewModel.SkipLotAndExpiration);
    }

    // --- UpdateCurrentLotToThis unblocks the gate (item 5) ---

    [Fact]
    public async Task UpdateCurrentLotToThisWithALotNumberUnblocksEnterIntoPioneer()
    {
        var apiService = new FakeVaccineApiService(); // no lot on file at all
        var viewModel = CreateViewModel(apiService);
        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);
        Assert.False(viewModel.EnterIntoPioneerCommand.CanExecute(null));

        viewModel.UpdateCurrentLotToThis = true;
        Assert.False(viewModel.EnterIntoPioneerCommand.CanExecute(null)); // still no lot NUMBER typed yet

        viewModel.NewLotNumber = "NEWLOT1";
        Assert.True(viewModel.EnterIntoPioneerCommand.CanExecute(null));
    }

    [Fact]
    public async Task EnterIntoPioneerSavesTheTypedLotAndDeletesEveryOtherLotForThatVaccine()
    {
        var apiService = new FakeVaccineApiService();
        var staleLotId = Guid.NewGuid();
        apiService.LotsByVaccineId[SampleVaccine.Id] = new()
        {
            new Lot { Id = staleLotId, VaccineId = SampleVaccine.Id, LotNumber = "STALE", Expiration = DateOnly.FromDateTime(DateTime.Today.AddDays(-5)), Status = "active" },
        };
        var sequence = new PayloadCapturingPioneerEntrySequence();
        var viewModel = CreateViewModel(apiService, sequence);
        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);

        viewModel.UpdateCurrentLotToThis = true;
        viewModel.NewLotNumber = "FRESHLOT";
        viewModel.NewLotExpiration = DateTime.Today.AddYears(1);
        Assert.True(viewModel.EnterIntoPioneerCommand.CanExecute(null));

        viewModel.EnterIntoPioneerCommand.Execute(null);
        await Settle(viewModel);

        var created = Assert.Single(apiService.CreatedLots);
        Assert.Equal("FRESHLOT", created.LotNumber);
        Assert.Equal(new[] { staleLotId }, apiService.DeletedLotIds);
        Assert.False(viewModel.UpdateCurrentLotToThis); // reset after a successful apply
        Assert.Equal("", viewModel.NewLotNumber);
        Assert.NotNull(sequence.CapturedPayload);
        Assert.Equal("FRESHLOT", sequence.CapturedPayload!.LotNumber);
    }

    [Fact]
    public async Task AFailedUpdateCurrentLotSaveSurfacesAnErrorAndNeverReachesTheSequence()
    {
        var apiService = new FakeVaccineApiService();
        var sequence = new PayloadCapturingPioneerEntrySequence();
        var viewModel = CreateViewModel(apiService, sequence);
        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);

        apiService.DeleteLotException = new InvalidOperationException("cloud is down");
        apiService.LotsByVaccineId[SampleVaccine.Id] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = SampleVaccine.Id, LotNumber = "OTHER", Expiration = DateOnly.FromDateTime(DateTime.Today.AddDays(-5)), Status = "active" },
        };
        viewModel.UpdateCurrentLotToThis = true;
        viewModel.NewLotNumber = "FRESHLOT";
        viewModel.NewLotExpiration = DateTime.Today.AddYears(1);

        viewModel.EnterIntoPioneerCommand.Execute(null);
        await Settle(viewModel);

        Assert.Null(sequence.CapturedPayload);
        Assert.Contains("cloud is down", viewModel.ErrorMessage);
    }

    // --- RequiresVarUpdateConfirmation (item 6) ---

    [Fact]
    public async Task NoLotOnFileDoesNotRequireVarConfirmation()
    {
        var apiService = new FakeVaccineApiService();
        var viewModel = CreateViewModel(apiService);
        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);

        Assert.False(viewModel.RequiresVarUpdateConfirmation);
    }

    [Fact]
    public async Task AnExpiredLotRequiresVarConfirmation()
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

        Assert.True(viewModel.RequiresVarUpdateConfirmation);
    }

    [Fact]
    public async Task ALotPastItsBeyondUseDateRequiresVarConfirmation()
    {
        var apiService = new FakeVaccineApiService();
        apiService.LotsByVaccineId[SampleVaccine.Id] = new()
        {
            new Lot
            {
                Id = Guid.NewGuid(), VaccineId = SampleVaccine.Id, LotNumber = "BUD1", Status = "active",
                Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)),
                BeyondUseDate = DateOnly.FromDateTime(DateTime.Today.AddDays(-1)),
            },
        };
        var viewModel = CreateViewModel(apiService);
        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);

        Assert.True(viewModel.RequiresVarUpdateConfirmation);
    }

    [Fact]
    public async Task AFineUnexpiredLotDoesNotRequireVarConfirmation()
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

        Assert.False(viewModel.RequiresVarUpdateConfirmation);
    }

    // --- The gate actually blocks/allows EnterIntoPioneerAsync (item 6) ---

    [Fact]
    public async Task EnterIntoPioneerFailsClosedWhenNoConfirmationHandlerIsWired()
    {
        var apiService = new FakeVaccineApiService();
        apiService.LotsByVaccineId[SampleVaccine.Id] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = SampleVaccine.Id, LotNumber = "OLD1", Expiration = DateOnly.FromDateTime(DateTime.Today.AddDays(-5)), Status = "active" },
        };
        var sequence = new PayloadCapturingPioneerEntrySequence();
        var viewModel = CreateViewModel(apiService, sequence);
        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);
        viewModel.SkipLotAndExpirationCommand.Execute(null); // unblocks CanExecute; ConfirmVarUpdateRequested stays null

        viewModel.EnterIntoPioneerCommand.Execute(null);
        await Settle(viewModel);

        Assert.Null(sequence.CapturedPayload);
        Assert.Contains("VAR", viewModel.ErrorMessage);
    }

    [Fact]
    public async Task EnterIntoPioneerBlocksWhenTheConfirmationHandlerReturnsFalse()
    {
        var apiService = new FakeVaccineApiService();
        apiService.LotsByVaccineId[SampleVaccine.Id] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = SampleVaccine.Id, LotNumber = "OLD1", Expiration = DateOnly.FromDateTime(DateTime.Today.AddDays(-5)), Status = "active" },
        };
        var sequence = new PayloadCapturingPioneerEntrySequence();
        var viewModel = CreateViewModel(apiService, sequence);
        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);
        viewModel.SkipLotAndExpirationCommand.Execute(null);
        viewModel.ConfirmVarUpdateRequested = _ => false; // pharmacist not asked yet — user clicked Cancel

        viewModel.EnterIntoPioneerCommand.Execute(null);
        await Settle(viewModel);

        Assert.Null(sequence.CapturedPayload);
    }

    [Fact]
    public async Task EnterIntoPioneerProceedsWhenTheConfirmationHandlerReturnsTrue()
    {
        var apiService = new FakeVaccineApiService();
        apiService.LotsByVaccineId[SampleVaccine.Id] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = SampleVaccine.Id, LotNumber = "OLD1", Expiration = DateOnly.FromDateTime(DateTime.Today.AddDays(-5)), Status = "active" },
        };
        var sequence = new PayloadCapturingPioneerEntrySequence();
        var viewModel = CreateViewModel(apiService, sequence);
        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);
        viewModel.SkipLotAndExpirationCommand.Execute(null);

        var messageShown = "";
        viewModel.ConfirmVarUpdateRequested = message => { messageShown = message; return true; };

        viewModel.EnterIntoPioneerCommand.Execute(null);
        await Settle(viewModel);

        Assert.NotNull(sequence.CapturedPayload);
        Assert.Contains("VAR", messageShown);
    }

    [Fact]
    public async Task SuccessfullyUpdatingTheCurrentLotSkipsTheVarPromptEntirely()
    {
        // The lot was JUST fixed by the "Update current lots to this lot"
        // checkbox — RequiresVarUpdateConfirmation must re-evaluate to
        // false off the freshly refreshed (non-expired) lot, so no VAR
        // popup should even be attempted.
        var apiService = new FakeVaccineApiService();
        apiService.LotsByVaccineId[SampleVaccine.Id] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = SampleVaccine.Id, LotNumber = "OLD1", Expiration = DateOnly.FromDateTime(DateTime.Today.AddDays(-5)), Status = "active" },
        };
        var sequence = new PayloadCapturingPioneerEntrySequence();
        var viewModel = CreateViewModel(apiService, sequence);
        viewModel.PatientAgeYears = 30;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);

        var confirmationCalls = 0;
        viewModel.ConfirmVarUpdateRequested = _ => { confirmationCalls++; return false; };

        viewModel.UpdateCurrentLotToThis = true;
        viewModel.NewLotNumber = "BRANDNEW";
        viewModel.NewLotExpiration = DateTime.Today.AddYears(1);
        viewModel.EnterIntoPioneerCommand.Execute(null);
        await Settle(viewModel);

        Assert.Equal(0, confirmationCalls); // never even asked
        Assert.NotNull(sequence.CapturedPayload);
        Assert.Equal("BRANDNEW", sequence.CapturedPayload!.LotNumber);
    }
}
