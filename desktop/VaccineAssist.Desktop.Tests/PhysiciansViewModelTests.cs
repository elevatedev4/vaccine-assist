using System;
using System.Linq;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Physicians settings tab (Will, 2026-09-05) — physicians (display name
/// + Pioneer alternate ID) and the vaccine/age-range -> physician rules
/// DataEntryPopupViewModel.BuildLivePayloadAsync resolves against at
/// entry time. See TestDoubles.FakeVaccineApiService's in-memory
/// PhysicianRows/PhysicianRuleRows.
/// </summary>
public class PhysiciansViewModelTests
{
    private static PhysiciansViewModel CreateViewModel(out FakeVaccineApiService apiService)
    {
        apiService = new FakeVaccineApiService();
        return new PhysiciansViewModel(apiService);
    }

    [Fact]
    public async Task LoadPopulatesPhysiciansRulesAndVaccines()
    {
        var vaccine = new Vaccine { Id = Guid.NewGuid(), Name = "Flu", ShortCode = "flu" };
        var viewModel = CreateViewModel(out var apiService);
        apiService.Vaccines.Add(vaccine);
        apiService.PhysicianRows.Add(new Physician { Id = Guid.NewGuid(), DisplayName = "Rivera, Ana", AlternateId = "ALTPRIMARY" });
        apiService.PhysicianRuleRows.Add(new PhysicianRule { Id = Guid.NewGuid(), PhysicianId = Guid.NewGuid(), VaccineId = vaccine.Id, MinAge = 3 });

        await viewModel.LoadAsync();

        Assert.Single(viewModel.Physicians);
        Assert.Single(viewModel.PhysicianRules);
        Assert.Single(viewModel.Vaccines);
        Assert.Null(viewModel.ErrorMessage);
    }

    [Fact]
    public async Task AddPhysicianAddsToTheListAndClearsTheForm()
    {
        var viewModel = CreateViewModel(out var apiService);
        viewModel.NewPhysicianDisplayName = "Kim, David";
        viewModel.NewPhysicianAlternateId = "ALTSECOND";

        Assert.True(viewModel.AddPhysicianCommand.CanExecute(null));
        viewModel.AddPhysicianCommand.Execute(null);
        await Task.Delay(20);

        var added = Assert.Single(viewModel.Physicians);
        Assert.Equal("Kim, David", added.DisplayName);
        Assert.Equal("ALTSECOND", added.AlternateId);
        Assert.Equal("", viewModel.NewPhysicianDisplayName);
        Assert.Equal("", viewModel.NewPhysicianAlternateId);
        Assert.Single(apiService.PhysicianRows);
    }

    [Fact]
    public void AddPhysicianCommandDisabledUntilBothFieldsAreFilled()
    {
        var viewModel = CreateViewModel(out _);
        Assert.False(viewModel.AddPhysicianCommand.CanExecute(null));

        viewModel.NewPhysicianDisplayName = "Doe, Jane";
        Assert.False(viewModel.AddPhysicianCommand.CanExecute(null));

        viewModel.NewPhysicianAlternateId = "ALT1";
        Assert.True(viewModel.AddPhysicianCommand.CanExecute(null));
    }

    [Fact]
    public async Task AddPhysicianRejectsAnAlternateIdWithASpace()
    {
        var viewModel = CreateViewModel(out var apiService);
        viewModel.NewPhysicianDisplayName = "Doe, Jane";
        viewModel.NewPhysicianAlternateId = "has space";

        viewModel.AddPhysicianCommand.Execute(null);
        await Task.Delay(20);

        Assert.Empty(apiService.PhysicianRows);
        Assert.Contains("spaces", viewModel.ErrorMessage);
    }

    [Fact]
    public async Task DeletePhysicianRemovesItAndReloads()
    {
        var viewModel = CreateViewModel(out var apiService);
        var physician = new Physician { Id = Guid.NewGuid(), DisplayName = "Doe, Jane", AlternateId = "ALT1" };
        apiService.PhysicianRows.Add(physician);
        await viewModel.LoadAsync();
        Assert.Single(viewModel.Physicians);

        viewModel.DeletePhysicianCommand.Execute(physician);
        await Task.Delay(20);

        Assert.Empty(viewModel.Physicians);
        Assert.Empty(apiService.PhysicianRows);
    }

    [Fact]
    public async Task AddRuleWithAnyVaccineCheckedSendsNullVaccineId()
    {
        var viewModel = CreateViewModel(out var apiService);
        var physician = new Physician { Id = Guid.NewGuid(), DisplayName = "Kim, David", AlternateId = "ALTSECOND" };
        apiService.PhysicianRows.Add(physician);
        await viewModel.LoadAsync();

        viewModel.NewRulePhysician = viewModel.Physicians.Single();
        viewModel.NewRuleIsAnyVaccine = true;
        viewModel.NewRuleMinAgeText = "12";

        Assert.True(viewModel.AddRuleCommand.CanExecute(null));
        viewModel.AddRuleCommand.Execute(null);
        await Task.Delay(20);

        var rule = Assert.Single(apiService.PhysicianRuleRows);
        Assert.Null(rule.VaccineId);
        Assert.Equal(12, rule.MinAge);
    }

    [Fact]
    public void AddRuleCommandRequiresEitherAVaccineOrAnyVaccineChecked()
    {
        var viewModel = CreateViewModel(out var apiService);
        var physician = new Physician { Id = Guid.NewGuid(), DisplayName = "Doe, Jane", AlternateId = "ALT1" };
        apiService.PhysicianRows.Add(physician);
        viewModel.NewRulePhysician = physician;

        Assert.False(viewModel.AddRuleCommand.CanExecute(null)); // no vaccine chosen, wildcard not checked

        viewModel.NewRuleIsAnyVaccine = true;
        Assert.True(viewModel.AddRuleCommand.CanExecute(null));
    }

    [Fact]
    public async Task AddRuleRejectsMinAgeGreaterThanMaxAge()
    {
        var viewModel = CreateViewModel(out var apiService);
        var physician = new Physician { Id = Guid.NewGuid(), DisplayName = "Doe, Jane", AlternateId = "ALT1" };
        apiService.PhysicianRows.Add(physician);
        viewModel.NewRulePhysician = physician;
        viewModel.NewRuleIsAnyVaccine = true;
        viewModel.NewRuleMinAgeText = "20";
        viewModel.NewRuleMaxAgeText = "10";

        viewModel.AddRuleCommand.Execute(null);
        await Task.Delay(20);

        Assert.Empty(apiService.PhysicianRuleRows);
        Assert.Contains("Min age", viewModel.ErrorMessage);
    }

    [Fact]
    public async Task AddRuleRejectsNonNumericAge()
    {
        var viewModel = CreateViewModel(out var apiService);
        var physician = new Physician { Id = Guid.NewGuid(), DisplayName = "Doe, Jane", AlternateId = "ALT1" };
        apiService.PhysicianRows.Add(physician);
        viewModel.NewRulePhysician = physician;
        viewModel.NewRuleIsAnyVaccine = true;
        viewModel.NewRuleMinAgeText = "not-a-number";

        viewModel.AddRuleCommand.Execute(null);
        await Task.Delay(20);

        Assert.Empty(apiService.PhysicianRuleRows);
        Assert.Contains("whole number", viewModel.ErrorMessage);
    }

    [Fact]
    public async Task DeleteRuleRemovesIt()
    {
        var viewModel = CreateViewModel(out var apiService);
        var rule = new PhysicianRule { Id = Guid.NewGuid(), PhysicianId = Guid.NewGuid(), VaccineId = null };
        apiService.PhysicianRuleRows.Add(rule);
        await viewModel.LoadAsync();

        viewModel.DeleteRuleCommand.Execute(rule);
        await Task.Delay(20);

        Assert.Empty(viewModel.PhysicianRules);
        Assert.Empty(apiService.PhysicianRuleRows);
    }

    [Fact]
    public async Task DisplayNameHelpersResolveFromLoadedLists()
    {
        var vaccine = new Vaccine { Id = Guid.NewGuid(), Name = "Flu", ShortCode = "flu" };
        var physician = new Physician { Id = Guid.NewGuid(), DisplayName = "Kim, David", AlternateId = "ALTSECOND" };
        var viewModel = CreateViewModel(out var apiService);
        apiService.Vaccines.Add(vaccine);
        apiService.PhysicianRows.Add(physician);
        await viewModel.LoadAsync();

        var specificRule = new PhysicianRule { Id = Guid.NewGuid(), PhysicianId = physician.Id, VaccineId = vaccine.Id };
        var wildcardRule = new PhysicianRule { Id = Guid.NewGuid(), PhysicianId = physician.Id, VaccineId = null };

        Assert.Equal("Flu", viewModel.VaccineDisplayNameFor(specificRule));
        Assert.Equal("Any vaccine", viewModel.VaccineDisplayNameFor(wildcardRule));
        Assert.Equal("Kim, David", viewModel.PhysicianDisplayNameFor(specificRule));
    }
}
