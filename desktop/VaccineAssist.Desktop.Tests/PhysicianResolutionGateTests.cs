using System;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Will, 2026-09-05: "need a way to assign which vaccines/age ranges
/// apply which doctor... if none matches, block with a clear message
/// pointing at settings." Covers DataEntryPopupViewModel.BuildLivePayloadAsync
/// (the physician-resolving payload EnterIntoPioneerCommand actually
/// runs) — see that method's doc comment. FakeVaccineApiService (see
/// TestDoubles.cs) defaults ResolvePhysicianResult to a resolved
/// physician so every OTHER DataEntryPopupViewModel test file (written
/// before this gate existed) keeps passing unchanged; this file is the
/// one that specifically exercises the block.
/// </summary>
public class PhysicianResolutionGateTests
{
    private static readonly Vaccine SampleVaccine = new()
    {
        Id = Guid.NewGuid(),
        Name = "Comirnaty",
        ShortCode = "comirnaty",
        Ndc = "00069-2025-10",
    };

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
    public async Task NoMatchingPhysicianRuleBlocksEntryWithAMessagePointingAtSettings()
    {
        var apiService = new FakeVaccineApiService { ResolvePhysicianResult = null };
        apiService.LotsByVaccineId[SampleVaccine.Id] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = SampleVaccine.Id, LotNumber = "GOOD1", Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)), Status = "active" },
        };
        var sequence = new PayloadCapturingPioneerEntrySequence();
        var viewModel = CreateViewModel(apiService, sequence);
        viewModel.PatientAgeYears = 40;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);

        // The lot/eligibility gate itself is unaffected — CanExecute only
        // checks Gate.CanEnterIntoPioneer + the lot gate, not the
        // physician rule (which is resolved fresh at RUN time, not
        // reflected in a bindable property) — so the button stays
        // enabled, but running it must still refuse to proceed.
        viewModel.EnterIntoPioneerCommand.Execute(null);
        await Settle(viewModel);

        Assert.Null(sequence.CapturedPayload); // sequence must never run without a resolved physician
        Assert.Contains("Physicians settings", viewModel.ErrorMessage);
        Assert.Contains("Comirnaty", viewModel.ErrorMessage);
        Assert.Contains("age 40", viewModel.ErrorMessage);
    }

    [Fact]
    public async Task ResolvedPhysicianReachesTheSequencePayload()
    {
        var physician = new Physician { Id = Guid.NewGuid(), DisplayName = "Kim, David", AlternateId = "ALTSECOND" };
        var apiService = new FakeVaccineApiService { ResolvePhysicianResult = physician };
        apiService.LotsByVaccineId[SampleVaccine.Id] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = SampleVaccine.Id, LotNumber = "GOOD1", Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)), Status = "active" },
        };
        var sequence = new PayloadCapturingPioneerEntrySequence();
        var viewModel = CreateViewModel(apiService, sequence);
        viewModel.PatientAgeYears = 40;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);

        viewModel.EnterIntoPioneerCommand.Execute(null);
        await Settle(viewModel);

        Assert.NotNull(sequence.CapturedPayload);
        Assert.Equal("ALTSECOND", sequence.CapturedPayload!.PhysicianAlternateId);
        Assert.Equal("00069-2025-10", sequence.CapturedPayload.Ndc);
        Assert.Equal(1, apiService.ResolvePhysicianCallCount);
    }

    [Fact]
    public async Task CopyToClipboardDoesNotRequireAResolvedPhysician()
    {
        // The clipboard fallback (staff without a Physicians rule set up
        // yet, or who just want the old copy/paste flow) must keep
        // working even with no physician resolvable — ToClipboardPayload
        // never included physician info even in the macro era.
        var apiService = new FakeVaccineApiService { ResolvePhysicianResult = null };
        apiService.LotsByVaccineId[SampleVaccine.Id] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = SampleVaccine.Id, LotNumber = "GOOD1", Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)), Status = "active" },
        };
        var viewModel = CreateViewModel(apiService);
        viewModel.PatientAgeYears = 40;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);

        Assert.True(viewModel.CopyToClipboardCommand.CanExecute(null));
        viewModel.CopyToClipboardCommand.Execute(null);
        await Settle(viewModel);

        Assert.Null(viewModel.ErrorMessage);
        Assert.Equal(0, apiService.ResolvePhysicianCallCount);
    }
}
