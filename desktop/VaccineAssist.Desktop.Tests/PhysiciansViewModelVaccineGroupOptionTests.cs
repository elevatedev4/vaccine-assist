using System;
using System.Linq;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// 2026-09-07: the Physicians tab's "Vaccine" ComboBox can now target a
/// whole VaccineGroupCatalog group ("All &lt;group&gt; vaccines"), not just
/// one specific vaccine or the true "any vaccine" wildcard — see
/// PhysiciansViewModel.BuildVaccineOptions/VaccineOptionsView and
/// Models/PhysicianRuleVaccineOption.cs.
/// </summary>
public class PhysiciansViewModelVaccineGroupOptionTests
{
    private static PhysiciansViewModel CreateViewModel(out FakeVaccineApiService apiService)
    {
        apiService = new FakeVaccineApiService();
        return new PhysiciansViewModel(apiService);
    }

    [Fact]
    public async Task BuildsAnAllGroupOptionFirstThenSpecificVaccinesInDisplayOrder()
    {
        var viewModel = CreateViewModel(out var apiService);
        apiService.Vaccines.Add(new Vaccine { Id = Guid.NewGuid(), Name = "Spikevax", ShortCode = "spikevax" });
        apiService.Vaccines.Add(new Vaccine { Id = Guid.NewGuid(), Name = "Comirnaty 2025-26 12+", ShortCode = "comirnaty" });
        apiService.Vaccines.Add(new Vaccine { Id = Guid.NewGuid(), Name = "Boostrix", ShortCode = "boostrix" });

        await viewModel.LoadAsync();

        var covidOptions = viewModel.VaccineOptions.Where(o => o.Group == "COVID vaccines").ToArray();
        Assert.Equal("All COVID vaccines", covidOptions[0].DisplayText);
        Assert.True(covidOptions[0].IsGroupWildcard);
        Assert.Equal(new[] { "Comirnaty 2025-26 12+", "Spikevax" }, covidOptions.Skip(1).Select(o => o.DisplayText));
        Assert.All(covidOptions.Skip(1), o => Assert.False(o.IsGroupWildcard));

        // V-T21 item 7: exactly 3 physicians-tab groups now (Flu/COVID/
        // Other), in that order — Boostrix (fine-grained "Tetanus/
        // whooping cough") buckets into the catch-all "Other vaccines"
        // here, which must come AFTER "COVID vaccines".
        var covidIndex = viewModel.VaccineOptions.ToList().FindIndex(o => o.Group == "COVID vaccines");
        var otherIndex = viewModel.VaccineOptions.ToList().FindIndex(o => o.Group == "Other vaccines");
        Assert.True(covidIndex < otherIndex);
    }

    [Fact]
    public async Task SelectingAGroupOptionSendsVaccineGroupAndNullVaccineId()
    {
        var viewModel = CreateViewModel(out var apiService);
        var physician = new Physician { Id = Guid.NewGuid(), DisplayName = "Kim, David", AlternateId = "ALTSECOND" };
        apiService.PhysicianRows.Add(physician);
        apiService.Vaccines.Add(new Vaccine { Id = Guid.NewGuid(), Name = "Comirnaty 2025-26 12+", ShortCode = "comirnaty" });
        await viewModel.LoadAsync();

        viewModel.NewRulePhysician = viewModel.Physicians.Single();
        viewModel.NewRuleVaccineOption = viewModel.VaccineOptions.Single(o => o.Group == "COVID vaccines" && o.IsGroupWildcard);

        Assert.True(viewModel.AddRuleCommand.CanExecute(null));
        viewModel.AddRuleCommand.Execute(null);
        await Task.Delay(20);

        var rule = Assert.Single(apiService.PhysicianRuleRows);
        Assert.Null(rule.VaccineId);
        Assert.Equal("COVID", rule.VaccineGroup);
    }

    [Fact]
    public async Task SelectingASpecificVaccineOptionSendsVaccineIdAndNullGroup()
    {
        var viewModel = CreateViewModel(out var apiService);
        var physician = new Physician { Id = Guid.NewGuid(), DisplayName = "Kim, David", AlternateId = "ALTSECOND" };
        apiService.PhysicianRows.Add(physician);
        var comirnaty = new Vaccine { Id = Guid.NewGuid(), Name = "Comirnaty 2025-26 12+", ShortCode = "comirnaty" };
        apiService.Vaccines.Add(comirnaty);
        await viewModel.LoadAsync();

        viewModel.NewRulePhysician = viewModel.Physicians.Single();
        viewModel.NewRuleVaccineOption = viewModel.VaccineOptions.Single(o => o.Vaccine?.Id == comirnaty.Id);

        viewModel.AddRuleCommand.Execute(null);
        await Task.Delay(20);

        var rule = Assert.Single(apiService.PhysicianRuleRows);
        Assert.Equal(comirnaty.Id, rule.VaccineId);
        Assert.Null(rule.VaccineGroup);
    }

    [Fact]
    public async Task AnyVaccineCheckedIgnoresASelectedGroupOption()
    {
        var viewModel = CreateViewModel(out var apiService);
        var physician = new Physician { Id = Guid.NewGuid(), DisplayName = "Kim, David", AlternateId = "ALTSECOND" };
        apiService.PhysicianRows.Add(physician);
        apiService.Vaccines.Add(new Vaccine { Id = Guid.NewGuid(), Name = "Comirnaty 2025-26 12+", ShortCode = "comirnaty" });
        await viewModel.LoadAsync();

        viewModel.NewRulePhysician = viewModel.Physicians.Single();
        viewModel.NewRuleVaccineOption = viewModel.VaccineOptions.Single(o => o.Group == "COVID vaccines" && o.IsGroupWildcard);
        viewModel.NewRuleIsAnyVaccine = true;

        viewModel.AddRuleCommand.Execute(null);
        await Task.Delay(20);

        var rule = Assert.Single(apiService.PhysicianRuleRows);
        Assert.Null(rule.VaccineId);
        Assert.Null(rule.VaccineGroup);
    }

    [Fact]
    public async Task VaccineDisplayNameForShowsAllGroupVaccinesForAGroupRule()
    {
        var viewModel = CreateViewModel(out var apiService);
        await viewModel.LoadAsync();
        var groupRule = new PhysicianRule { Id = Guid.NewGuid(), PhysicianId = Guid.NewGuid(), VaccineId = null, VaccineGroup = "COVID" };

        Assert.Equal("All COVID vaccines", viewModel.VaccineDisplayNameFor(groupRule));
    }
}
