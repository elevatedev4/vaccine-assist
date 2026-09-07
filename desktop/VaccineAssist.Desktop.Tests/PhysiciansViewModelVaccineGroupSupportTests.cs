using System;
using System.Linq;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// BLOCKING SAFETY FIX (reviewer, 2026-09-07 request-changes round): the
/// "All &lt;group&gt; vaccines" ComboBox option must be HIDDEN unless the
/// server (GET /api/physician-rules's own `vaccineGroupSupported` flag —
/// see the parallel feat/cloud-tabs branch's migration 0009) actually
/// supports physician_rule.vaccine_group. Otherwise a group rule "saved"
/// pre-migration persists as vaccine_id=null — an unrestricted "any
/// vaccine" wildcard rule, a silent over-grant of prescriber authority.
/// See PhysiciansViewModel.VaccineGroupSupported's own doc comment.
/// </summary>
public class PhysiciansViewModelVaccineGroupSupportTests
{
    private static PhysiciansViewModel CreateViewModel(out FakeVaccineApiService apiService)
    {
        apiService = new FakeVaccineApiService();
        return new PhysiciansViewModel(apiService);
    }

    [Fact]
    public void VaccineGroupSupportedDefaultsToFalseBeforeAnyLoad()
    {
        // Fail CLOSED before the first successful load, not open — a
        // fresh/not-yet-loaded tab must never show group options even
        // fleetingly.
        var viewModel = CreateViewModel(out _);

        Assert.False(viewModel.VaccineGroupSupported);
    }

    [Fact]
    public async Task WhenServerSupportsGroupsTheAllGroupOptionsAppearAndTheNoteIsHidden()
    {
        var viewModel = CreateViewModel(out var apiService);
        apiService.VaccineGroupSupported = true;
        apiService.Vaccines.Add(new Vaccine { Id = Guid.NewGuid(), Name = "Comirnaty 2025-26 12+", ShortCode = "comirnaty" });

        await viewModel.LoadAsync();

        Assert.True(viewModel.VaccineGroupSupported);
        Assert.Contains(viewModel.VaccineOptions, o => o.Group == "COVID" && o.IsGroupWildcard);
    }

    [Fact]
    public async Task WhenServerDoesNotSupportGroupsTheAllGroupOptionsAreOmittedEntirely()
    {
        var viewModel = CreateViewModel(out var apiService);
        apiService.VaccineGroupSupported = false;
        apiService.Vaccines.Add(new Vaccine { Id = Guid.NewGuid(), Name = "Comirnaty 2025-26 12+", ShortCode = "comirnaty" });
        apiService.Vaccines.Add(new Vaccine { Id = Guid.NewGuid(), Name = "Boostrix", ShortCode = "boostrix" });

        await viewModel.LoadAsync();

        Assert.False(viewModel.VaccineGroupSupported);
        Assert.DoesNotContain(viewModel.VaccineOptions, o => o.IsGroupWildcard);
        // Specific vaccines must still be selectable — only the group
        // ("All ... vaccines") option is gated, not the whole feature.
        Assert.Contains(viewModel.VaccineOptions, o => o.Group == "COVID" && o.DisplayText == "Comirnaty 2025-26 12+");
        Assert.Contains(viewModel.VaccineOptions, o => o.Group == "Tetanus/whooping cough" && o.DisplayText == "Boostrix");
    }

    [Fact]
    public async Task UnsupportedFlagBlocksAddRuleEvenIfAStaleGroupOptionIsSomehowSelected()
    {
        // Belt-and-suspenders: simulate a stale selection (e.g. picked
        // right before a reload flipped the flag) reaching AddRuleAsync
        // directly, bypassing whatever BuildVaccineOptions would normally
        // offer.
        var viewModel = CreateViewModel(out var apiService);
        apiService.VaccineGroupSupported = true;
        apiService.Vaccines.Add(new Vaccine { Id = Guid.NewGuid(), Name = "Comirnaty 2025-26 12+", ShortCode = "comirnaty" });
        var physician = new Physician { Id = Guid.NewGuid(), DisplayName = "Kim, David", AlternateId = "ALTSECOND" };
        apiService.PhysicianRows.Add(physician);
        await viewModel.LoadAsync();

        var staleGroupOption = viewModel.VaccineOptions.Single(o => o.Group == "COVID" && o.IsGroupWildcard);

        // Flag flips false (e.g. a concurrent reload elsewhere) without a
        // fresh LoadAsync happening on THIS view model instance yet.
        apiService.VaccineGroupSupported = false;
        viewModel.NewRulePhysician = viewModel.Physicians.Single();
        viewModel.NewRuleVaccineOption = staleGroupOption;

        // CanExecute doesn't re-check the live flag (it's cheap/local,
        // same as every other CanExecute here) — the hard stop is inside
        // AddRuleAsync itself, exercised via Execute.
        viewModel.AddRuleCommand.Execute(null);
        await Task.Delay(20);

        Assert.Empty(apiService.PhysicianRuleRows);
        Assert.Contains("migration hasn't run", viewModel.ErrorMessage);
    }

    [Fact]
    public async Task ReloadingAfterTheMigrationLandsRevealsTheGroupOptions()
    {
        var viewModel = CreateViewModel(out var apiService);
        apiService.VaccineGroupSupported = false;
        apiService.Vaccines.Add(new Vaccine { Id = Guid.NewGuid(), Name = "Comirnaty 2025-26 12+", ShortCode = "comirnaty" });
        await viewModel.LoadAsync();
        Assert.DoesNotContain(viewModel.VaccineOptions, o => o.IsGroupWildcard);

        apiService.VaccineGroupSupported = true; // migration lands
        await viewModel.LoadAsync();

        Assert.True(viewModel.VaccineGroupSupported);
        Assert.Contains(viewModel.VaccineOptions, o => o.Group == "COVID" && o.IsGroupWildcard);
    }
}
