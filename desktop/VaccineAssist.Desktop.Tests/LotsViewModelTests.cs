using System;
using System.Linq;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// MSG893 item 4 ("Lots screen becomes an editable table with autosave"):
/// LotsViewModel.LoadAsync now joins vaccine name/NDC into each
/// LotRowViewModel (from GetAllVaccinesAsync, not just the active-only
/// Vaccines list — see that method's own doc comment), and
/// OnRowEditCommitted persists a row edit via UpdateLotAsync, reporting
/// success/failure back to the row. Uses FakeVaccineApiService
/// (TestDoubles.cs) — no HTTP, no WPF.
/// </summary>
public class LotsViewModelTests
{
    private static Vaccine MakeVaccine(string name, string? ndc = null, bool active = true) => new()
    {
        Id = Guid.NewGuid(),
        Name = name,
        Ndc = ndc,
        ShortCode = name.ToLowerInvariant(),
        Active = active,
    };

    [Fact]
    public async Task LoadJoinsVaccineNameAndNdcIntoEachLotRow()
    {
        var apiService = new FakeVaccineApiService();
        var vaccine = MakeVaccine("MMR-II", "00000-1111-01");
        apiService.Vaccines.Add(vaccine);
        apiService.AllVaccines.Add(vaccine);
        apiService.LotsByVaccineId[vaccine.Id] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = vaccine.Id, LotNumber = "L1", Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)), Status = "active" },
        };
        var viewModel = new LotsViewModel(apiService);

        await viewModel.LoadAsync();

        var row = Assert.Single(viewModel.Lots);
        Assert.Equal("MMR-II", row.VaccineName);
        Assert.Equal("00000-1111-01", row.VaccineNdc);
        Assert.Equal("L1", row.LotNumber);
    }

    [Fact]
    public async Task LoadFindsVaccineNameEvenWhenOnlyInactiveOrOrphanRowsMatch()
    {
        // The join deliberately uses GetAllVaccinesAsync (active + inactive),
        // not the active-only Vaccines list the Add-a-lot picker uses — a
        // lot attached to a deactivated or orphan-duplicate vaccine row
        // (see DataEntryPopupViewModel.FindActiveLotForVaccineAsync's doc
        // comment on the known orphan-duplicate-vaccine data issue) must
        // still show a real name/NDC, not blank.
        var apiService = new FakeVaccineApiService();
        var inactiveVaccine = MakeVaccine("Old Formulation", "99999-0000-01", active: false);
        apiService.AllVaccines.Add(inactiveVaccine); // NOT in apiService.Vaccines
        apiService.LotsByVaccineId[inactiveVaccine.Id] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = inactiveVaccine.Id, LotNumber = "OLDLOT", Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)), Status = "active" },
        };
        var viewModel = new LotsViewModel(apiService);

        await viewModel.LoadAsync();

        var row = Assert.Single(viewModel.Lots);
        Assert.Equal("Old Formulation", row.VaccineName);
        Assert.Equal("99999-0000-01", row.VaccineNdc);
    }

    [Fact]
    public async Task LoadFallsBackToAPlaceholderNameWhenNoVaccineRowMatchesAtAll()
    {
        var apiService = new FakeVaccineApiService();
        var orphanVaccineId = Guid.NewGuid();
        apiService.LotsByVaccineId[orphanVaccineId] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = orphanVaccineId, LotNumber = "ORPHANLOT", Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)), Status = "active" },
        };
        var viewModel = new LotsViewModel(apiService);

        await viewModel.LoadAsync();

        var row = Assert.Single(viewModel.Lots);
        Assert.Equal("(unknown vaccine)", row.VaccineName);
        Assert.Null(row.VaccineNdc);
    }

    [Fact]
    public async Task EditingARowAutosavesViaUpdateLotAsync()
    {
        var apiService = new FakeVaccineApiService();
        var vaccine = MakeVaccine("MMR-II");
        apiService.AllVaccines.Add(vaccine);
        var lotId = Guid.NewGuid();
        apiService.LotsByVaccineId[vaccine.Id] = new()
        {
            new Lot { Id = lotId, VaccineId = vaccine.Id, LotNumber = "OLD", Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)), Status = "active" },
        };
        var viewModel = new LotsViewModel(apiService);
        await viewModel.LoadAsync();
        var row = viewModel.Lots.Single();

        row.LotNumber = "NEW";
        await Task.Delay(20); // OnRowEditCommitted is async void, fired synchronously from the setter

        var saved = Assert.Single(apiService.UpdatedLots);
        Assert.Equal(lotId, saved.Id);
        Assert.Equal("NEW", saved.LotNumber);
        Assert.Null(row.SaveError);
    }

    [Fact]
    public async Task EditingBeyondUseDateAutosavesAsADateOnlyOrNull()
    {
        var apiService = new FakeVaccineApiService();
        var vaccine = MakeVaccine("MMR-II");
        apiService.AllVaccines.Add(vaccine);
        var lotId = Guid.NewGuid();
        apiService.LotsByVaccineId[vaccine.Id] = new()
        {
            new Lot { Id = lotId, VaccineId = vaccine.Id, LotNumber = "L1", Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)), Status = "active" },
        };
        var viewModel = new LotsViewModel(apiService);
        await viewModel.LoadAsync();
        var row = viewModel.Lots.Single();

        var bud = DateTime.Today.AddDays(30);
        row.BeyondUseDate = bud;
        await Task.Delay(20);

        var saved = Assert.Single(apiService.UpdatedLots);
        Assert.Equal(DateOnly.FromDateTime(bud), saved.BeyondUseDate);
    }

    [Fact]
    public async Task AFailedAutosaveRevertsTheRowAndSurfacesAnInlineError()
    {
        var apiService = new FakeVaccineApiService();
        var vaccine = MakeVaccine("MMR-II");
        apiService.AllVaccines.Add(vaccine);
        var lotId = Guid.NewGuid();
        apiService.LotsByVaccineId[vaccine.Id] = new()
        {
            new Lot { Id = lotId, VaccineId = vaccine.Id, LotNumber = "GOOD", Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)), Status = "active" },
        };
        var viewModel = new LotsViewModel(apiService);
        await viewModel.LoadAsync();
        var row = viewModel.Lots.Single();

        apiService.UpdateLotException = new InvalidOperationException("cloud is down");
        row.LotNumber = "BAD";
        await Task.Delay(20);

        Assert.Equal("GOOD", row.LotNumber); // reverted
        Assert.NotNull(row.SaveError);
        Assert.Contains("cloud is down", row.SaveError);
    }

    [Fact]
    public async Task AddLotCommandAddsAnEditableAutosavingRow()
    {
        var apiService = new FakeVaccineApiService();
        var vaccine = MakeVaccine("Boostrix", "12345-6789-01");
        apiService.Vaccines.Add(vaccine);
        apiService.AllVaccines.Add(vaccine);
        var viewModel = new LotsViewModel(apiService);
        await viewModel.LoadAsync();

        viewModel.NewLotVaccine = vaccine;
        viewModel.NewLotNumber = "SHIP1";
        viewModel.NewLotExpiration = DateTime.Today.AddYears(1);
        viewModel.AddLotCommand.Execute(null);
        await Task.Delay(20);

        var row = Assert.Single(viewModel.Lots);
        Assert.Equal("SHIP1", row.LotNumber);
        Assert.Equal("Boostrix", row.VaccineName);
        Assert.Equal("12345-6789-01", row.VaccineNdc);

        // The newly-added row must autosave too, same as any loaded row.
        row.Note = "edited after add";
        await Task.Delay(20);
        Assert.Contains(apiService.UpdatedLots, u => u.Id == row.Id && u.Note == "edited after add");
    }

    [Fact]
    public async Task LoadPartitionsRowsIntoActiveAndInactiveLotsByTheJoinedVaccinesActiveFlag()
    {
        // V-T21 item 4: ActiveLots/InactiveLots split the same rows Lots
        // holds, by LotRowViewModel.IsVaccineActive (joined from
        // GetAllVaccinesAsync's Vaccine.Active — see LoadAsync).
        var apiService = new FakeVaccineApiService();
        var activeVaccine = MakeVaccine("MMR-II", active: true);
        var inactiveVaccine = MakeVaccine("Old Formulation", active: false);
        apiService.AllVaccines.Add(activeVaccine);
        apiService.AllVaccines.Add(inactiveVaccine);
        apiService.LotsByVaccineId[activeVaccine.Id] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = activeVaccine.Id, LotNumber = "ACTIVELOT", Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)), Status = "active" },
        };
        apiService.LotsByVaccineId[inactiveVaccine.Id] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = inactiveVaccine.Id, LotNumber = "INACTIVELOT", Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)), Status = "active" },
        };
        var viewModel = new LotsViewModel(apiService);

        await viewModel.LoadAsync();

        Assert.Equal(2, viewModel.Lots.Count);
        var activeRow = Assert.Single(viewModel.ActiveLots);
        Assert.Equal("ACTIVELOT", activeRow.LotNumber);
        Assert.True(activeRow.IsVaccineActive);
        var inactiveRow = Assert.Single(viewModel.InactiveLots);
        Assert.Equal("INACTIVELOT", inactiveRow.LotNumber);
        Assert.False(inactiveRow.IsVaccineActive);
    }

    [Fact]
    public async Task LoadTreatsAnOrphanLotWithNoMatchingVaccineRowAsActive()
    {
        var apiService = new FakeVaccineApiService();
        var orphanVaccineId = Guid.NewGuid();
        apiService.LotsByVaccineId[orphanVaccineId] = new()
        {
            new Lot { Id = Guid.NewGuid(), VaccineId = orphanVaccineId, LotNumber = "ORPHANLOT", Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)), Status = "active" },
        };
        var viewModel = new LotsViewModel(apiService);

        await viewModel.LoadAsync();

        var row = Assert.Single(viewModel.ActiveLots);
        Assert.Equal("ORPHANLOT", row.LotNumber);
        Assert.Empty(viewModel.InactiveLots);
    }

    [Fact]
    public async Task AddLotCommandAddsTheNewRowToActiveLots()
    {
        var apiService = new FakeVaccineApiService();
        var vaccine = MakeVaccine("Boostrix", "12345-6789-01");
        apiService.Vaccines.Add(vaccine);
        apiService.AllVaccines.Add(vaccine);
        var viewModel = new LotsViewModel(apiService);
        await viewModel.LoadAsync();

        viewModel.NewLotVaccine = vaccine;
        viewModel.NewLotNumber = "SHIP1";
        viewModel.NewLotExpiration = DateTime.Today.AddYears(1);
        viewModel.AddLotCommand.Execute(null);
        await Task.Delay(20);

        var row = Assert.Single(viewModel.ActiveLots);
        Assert.Equal("SHIP1", row.LotNumber);
        Assert.Empty(viewModel.InactiveLots);
    }

    [Fact]
    public async Task ReloadingDetachesOldRowsSoTheyNoLongerAutosave()
    {
        // If LoadAsync didn't unsubscribe EditCommitted from the previous
        // Lots before Clear()ing, an old (now-discarded) LotRowViewModel
        // that some stale reference still edits would keep firing saves
        // through a ViewModel instance that's since moved on.
        var apiService = new FakeVaccineApiService();
        var vaccine = MakeVaccine("MMR-II");
        apiService.AllVaccines.Add(vaccine);
        var lotId = Guid.NewGuid();
        apiService.LotsByVaccineId[vaccine.Id] = new()
        {
            new Lot { Id = lotId, VaccineId = vaccine.Id, LotNumber = "L1", Expiration = DateOnly.FromDateTime(DateTime.Today.AddYears(1)), Status = "active" },
        };
        var viewModel = new LotsViewModel(apiService);
        await viewModel.LoadAsync();
        var staleRow = viewModel.Lots.Single();

        await viewModel.LoadAsync(); // second load — replaces the row instances

        staleRow.LotNumber = "SHOULD-NOT-SAVE";
        await Task.Delay(20);

        Assert.DoesNotContain(apiService.UpdatedLots, u => u.LotNumber == "SHOULD-NOT-SAVE");
    }
}
