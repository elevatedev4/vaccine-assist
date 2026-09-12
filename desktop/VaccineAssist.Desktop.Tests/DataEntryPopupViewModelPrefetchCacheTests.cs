using System;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-..., 2026-09-11 ("start faster" — Will's feedback: "huge delay between
/// me pushing 'enter into pioneer' and anything happening"):
/// DataEntryPopupViewModel.EnsurePioneerEntryPrefetchStarted caches the
/// physician-resolution + active-lot lookup Tasks for the current (vaccine
/// id, age) so EnterIntoPioneerAsync's own "start it now" call and
/// BuildLivePayloadAsync's later "make sure it's running" call share ONE
/// pair of in-flight requests instead of BuildLivePayloadAsync firing a
/// second, redundant round trip. These tests prove the cache is actually
/// REUSED (not just that the final payload comes out right, which the
/// PhysicianResolutionGateTests/expiration-gate suites already cover) by
/// counting the underlying API calls.
/// </summary>
public class DataEntryPopupViewModelPrefetchCacheTests
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
    public async Task ASuccessfulLiveEntryResolvesThePhysicianExactlyOnceDespiteTwoEnsureCalls()
    {
        // EnterIntoPioneerAsync calls EnsurePioneerEntryPrefetchStarted
        // right at the click, and BuildLivePayloadAsync calls it again
        // right before it needs the result — if the cache weren't actually
        // reused, this would show up as 2 calls, not 1.
        var apiService = new FakeVaccineApiService();
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
        Assert.Equal(1, apiService.ResolvePhysicianCallCount);
    }

    [Fact]
    public async Task ASuccessfulLiveEntryFetchesTheActiveLotExactlyOnceFromTheClickOnward()
    {
        // Selecting the vaccine already triggers ONE GetLotsAsync call of
        // its own (RefreshSelectedVaccineActiveLotAsync, for the popup's
        // expiration gate — unrelated to the prefetch). From the click
        // onward, EnterIntoPioneerAsync's prefetch-start and
        // BuildLivePayloadAsync's ensure-call must share the SAME lot
        // lookup — exactly one more call, not two.
        var apiService = new FakeVaccineApiService();
        apiService.LotsByVaccineId[SampleVaccine.Id] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = SampleVaccine.Id, LotNumber = "GOOD1", Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)), Status = "active" },
        };
        var sequence = new PayloadCapturingPioneerEntrySequence();
        var viewModel = CreateViewModel(apiService, sequence);
        viewModel.PatientAgeYears = 40;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);

        var callsBeforeClick = apiService.GetLotsCallCount;

        viewModel.EnterIntoPioneerCommand.Execute(null);
        await Settle(viewModel);

        Assert.NotNull(sequence.CapturedPayload);
        Assert.Equal("GOOD1", sequence.CapturedPayload!.LotNumber);
        Assert.Equal(callsBeforeClick + 1, apiService.GetLotsCallCount);
    }

    [Fact]
    public async Task SwitchingVaccinesAfterASuccessfulEntryNeverReusesTheFirstVaccinesCachedLot()
    {
        // Cache invalidation: the prefetch key is (vaccine id, age). A
        // successful "Enter into Pioneer" for vaccine A leaves a cached
        // (now-completed) lot Task keyed to A sitting on the view-model —
        // this proves selecting a DIFFERENT vaccine B and entering again
        // gets B's own lot, not a leftover reference to A's.
        var otherVaccine = new Vaccine { Id = Guid.NewGuid(), Name = "Boostrix", ShortCode = "boostrix", Ndc = "00005-0000-01", Active = true };
        var apiService = new FakeVaccineApiService();
        apiService.LotsByVaccineId[SampleVaccine.Id] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = SampleVaccine.Id, LotNumber = "FIRSTLOT", Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)), Status = "active" },
        };
        apiService.LotsByVaccineId[otherVaccine.Id] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = otherVaccine.Id, LotNumber = "SECONDLOT", Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)), Status = "active" },
        };
        var sequence = new PayloadCapturingPioneerEntrySequence();
        var viewModel = CreateViewModel(apiService, sequence);
        viewModel.PatientAgeYears = 40;
        viewModel.SelectedVaccine = SampleVaccine;
        await Settle(viewModel);

        viewModel.EnterIntoPioneerCommand.Execute(null);
        await Settle(viewModel);
        Assert.Equal("FIRSTLOT", sequence.CapturedPayload!.LotNumber); // sanity: first entry used A's lot

        viewModel.SelectedVaccine = otherVaccine;
        await Settle(viewModel);
        viewModel.EnterIntoPioneerCommand.Execute(null);
        await Settle(viewModel);

        Assert.Equal("SECONDLOT", sequence.CapturedPayload!.LotNumber);
    }
}
