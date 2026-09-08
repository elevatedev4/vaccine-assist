using System;
using System.Linq;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// MSG893 item 3 ("mNEXSPIKE lot/exp not showing up right"): the Supabase
/// `vaccine` table has known orphan duplicate rows (same/similar name,
/// only ONE of the duplicates has a lot attached) — a data cleanup tracked
/// separately, NOT fixed by this branch (see DataEntryPopupViewModel.
/// FindActiveLotForVaccineAsync's own doc comment). These tests cover the
/// app-side mitigation: if the SELECTED vaccine row has no lot, fall back
/// to a sibling row (same Name, from the already-loaded eligible-vaccines
/// pool) that does — plus the token-guard that replaces the old
/// "did SelectedVaccine.Id change?" race check, which couldn't detect an
/// out-of-order response for the same vaccine at all.
/// </summary>
public class DataEntryPopupViewModelLotLookupRobustnessTests
{
    private static DataEntryPopupViewModel CreateViewModel(FakeVaccineApiService apiService) =>
        new(apiService, new NoOpClipboardService(), new NoOpPioneerEntrySequence(), pioneerWindowDetected: true);

    private static async Task Settle(DataEntryPopupViewModel viewModel)
    {
        for (var i = 0; i < 50 && viewModel.IsBusy; i++)
        {
            await Task.Delay(10);
        }
        await Task.Delay(20);
    }

    /// <summary>Drives ContinueFromAgeAsync -> SelectGroup so
    /// _eligibleVaccinesForAge (private) gets populated the same way a
    /// real guided-flow session would, landing on the Product stage with
    /// ProductOptions built — same pattern
    /// DataEntryPopupViewModelGuidedFlowTests.cs uses.</summary>
    private static async Task DriveToProductStageAsync(DataEntryPopupViewModel viewModel, int age, string group)
    {
        viewModel.PatientAgeYears = age;
        viewModel.ContinueFromAgeCommand.Execute(null);
        await Settle(viewModel);
        viewModel.SelectGroup(group);
    }

    [Fact]
    public async Task FallsBackToASiblingVaccineRowWithTheSameNameWhenTheSelectedRowHasNoLot()
    {
        var lotlessDuplicate = new Vaccine { Id = Guid.NewGuid(), Name = "mNEXSPIKE", ShortCode = "mnex1", Dose = "1", Active = true };
        var duplicateWithLot = new Vaccine { Id = Guid.NewGuid(), Name = "mNEXSPIKE", ShortCode = "mnex1dup", Dose = "1", Active = true };
        var apiService = new FakeVaccineApiService();
        apiService.EligibleVaccinesByAge[30] = new() { lotlessDuplicate, duplicateWithLot };
        apiService.LotsByVaccineId[duplicateWithLot.Id] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = duplicateWithLot.Id, LotNumber = "REALLOT", Status = "active", Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)) },
        };
        var viewModel = CreateViewModel(apiService);

        await DriveToProductStageAsync(viewModel, 30, "COVID");
        // Both duplicate rows share the exact same Name, so they land as
        // ONE product with two (near-identical) dose options — exactly
        // the confusing real-world shape this issue reported.
        var product = Assert.Single(viewModel.ProductOptions);
        Assert.True(product.IsMultiDose);
        viewModel.SelectProduct(product);
        viewModel.SelectDose(lotlessDuplicate); // the pharmacist picked the "wrong" (lot-less) duplicate row
        await Settle(viewModel);

        Assert.False(viewModel.IsLotExpiredOrMissing); // must NOT show a false "no lot" gate
        Assert.NotNull(viewModel.SelectedVaccineActiveLot);
        Assert.Equal("REALLOT", viewModel.SelectedVaccineActiveLot!.LotNumber);
    }

    [Fact]
    public async Task DoesNotFallBackToADifferentlyNamedVaccineEvenIfItHasALot()
    {
        var selected = new Vaccine { Id = Guid.NewGuid(), Name = "mNEXSPIKE", ShortCode = "mnex1", Dose = "1", Active = true };
        var unrelated = new Vaccine { Id = Guid.NewGuid(), Name = "Comirnaty 2025-26 12+", ShortCode = "comirnaty1", Dose = "1", Active = true };
        var apiService = new FakeVaccineApiService();
        apiService.EligibleVaccinesByAge[30] = new() { selected, unrelated };
        apiService.LotsByVaccineId[unrelated.Id] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = unrelated.Id, LotNumber = "COMIRNATYLOT", Status = "active", Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)) },
        };
        var viewModel = CreateViewModel(apiService);

        await DriveToProductStageAsync(viewModel, 30, "COVID");
        var product = viewModel.ProductOptions.Single(p => p.Name == "mNEXSPIKE");
        viewModel.SelectProduct(product); // single dose -> straight to Review with `selected`
        await Settle(viewModel);

        Assert.Equal(selected, viewModel.SelectedVaccine);
        Assert.True(viewModel.IsLotExpiredOrMissing); // no lot for THIS vaccine, and no same-name sibling either
        Assert.Null(viewModel.SelectedVaccineActiveLot);
    }

    [Fact]
    public async Task NoLotAnywhereIncludingSiblingsStillReportsMissingCleanly()
    {
        var lotless1 = new Vaccine { Id = Guid.NewGuid(), Name = "mNEXSPIKE", ShortCode = "mnex1", Dose = "1", Active = true };
        var lotless2 = new Vaccine { Id = Guid.NewGuid(), Name = "mNEXSPIKE", ShortCode = "mnex1dup", Dose = "1", Active = true };
        var apiService = new FakeVaccineApiService();
        apiService.EligibleVaccinesByAge[30] = new() { lotless1, lotless2 };
        var viewModel = CreateViewModel(apiService);

        await DriveToProductStageAsync(viewModel, 30, "COVID");
        var product = Assert.Single(viewModel.ProductOptions);
        viewModel.SelectProduct(product);
        viewModel.SelectDose(lotless1);
        await Settle(viewModel);

        Assert.True(viewModel.IsLotExpiredOrMissing);
        Assert.Null(viewModel.SelectedVaccineActiveLot);
        Assert.Contains("No unexpired lot on file", viewModel.LotGateMessage);
    }

    [Fact]
    public async Task AStaleSlowResponseDoesNotOverwriteANewerFasterOne()
    {
        // Regression coverage for the token-guard fix: the OLD guard
        // ("did SelectedVaccine.Id change?") could only ever catch a
        // switch to a DIFFERENT vaccine — an out-of-order response
        // resolving to the SAME vaccine (e.g. a slow retry) could still
        // silently win. Here the FIRST lookup is made to hang
        // (DelayNextGetLotsCall) while it still reflects "no lot yet"; a
        // lot is then added and a SECOND, faster lookup for the same
        // conceptual vaccine completes with it BEFORE the first one is
        // released — the first's eventual (stale, empty) result must not
        // un-clear the gate afterward.
        var vaccine = new Vaccine { Id = Guid.NewGuid(), Name = "MMR-II", ShortCode = "mmr1", Dose = "1", Active = true };
        var apiService = new FakeVaccineApiService();
        apiService.EligibleVaccinesByAge[30] = new() { vaccine };
        var viewModel = CreateViewModel(apiService);

        var gate = new TaskCompletionSource<bool>();
        apiService.DelayNextGetLotsCall = gate;
        await DriveToProductStageAsync(viewModel, 30, "MMR");
        var product = Assert.Single(viewModel.ProductOptions);
        viewModel.SelectProduct(product); // single dose -> fires the FIRST (now-suspended) lot lookup
        await Task.Delay(20);

        // A real lot shows up, and a SECOND lookup for the same
        // conceptual vaccine (a DISTINCT object with the same id — e.g. a
        // freshly re-fetched row, since SelectedVaccine's setter compares
        // by reference, not id) completes normally.
        apiService.LotsByVaccineId[vaccine.Id] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = vaccine.Id, LotNumber = "GOODLOT", Status = "active", Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)) },
        };
        var vaccineRefetched = new Vaccine { Id = vaccine.Id, Name = vaccine.Name, ShortCode = vaccine.ShortCode, Dose = vaccine.Dose, Active = true };
        viewModel.SelectDose(vaccineRefetched);
        await Settle(viewModel);

        Assert.False(viewModel.IsLotExpiredOrMissing);
        Assert.Equal("GOODLOT", viewModel.SelectedVaccineActiveLot!.LotNumber);

        // Now let the FIRST (stale) lookup finally complete — its
        // snapshot was captured before the lot existed, so it would
        // resolve to "no lot" if it were allowed to win.
        gate.SetResult(true);
        await Settle(viewModel);

        Assert.False(viewModel.IsLotExpiredOrMissing); // must still be clear — the stale result was ignored
        Assert.Equal("GOODLOT", viewModel.SelectedVaccineActiveLot!.LotNumber);
    }
}
