using System;
using System.Linq;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-... Part B: the data-entry popup's guided flow — age -> vaccine group
/// -> product -> dose (only when the product has more than one dose row) ->
/// review. See DataEntryPopupViewModel.CurrentStage/ContinueFromAgeAsync/
/// SelectGroup/SelectProduct/SelectDose/GoBack.
/// </summary>
public class DataEntryPopupViewModelGuidedFlowTests
{
    // COVID, single dose.
    private static readonly Vaccine Comirnaty = new() { Id = Guid.NewGuid(), Name = "Comirnaty 2025-26 12+", ShortCode = "comirnaty12", Dose = "1", Active = true };

    // Tetanus/whooping cough, single dose.
    private static readonly Vaccine Boostrix = new() { Id = Guid.NewGuid(), Name = "Boostrix", ShortCode = "boostrix", Dose = "1", Active = true };

    // HPV, three doses — deliberately listed out of dose order to prove
    // OrderByDose (not catalog order) drives the dose step's order.
    private static readonly Vaccine GardasilDose2 = new() { Id = Guid.NewGuid(), Name = "Gardasil", ShortCode = "gardasil2", Dose = "2", Active = true };
    private static readonly Vaccine GardasilDose1 = new() { Id = Guid.NewGuid(), Name = "Gardasil", ShortCode = "gardasil1", Dose = "1", Active = true };
    private static readonly Vaccine GardasilDose3 = new() { Id = Guid.NewGuid(), Name = "Gardasil", ShortCode = "gardasil3", Dose = "3", Active = true };

    private static DataEntryPopupViewModel CreateViewModelWithEligibleVaccinesForAge12()
    {
        var apiService = new FakeVaccineApiService();
        apiService.EligibleVaccinesByAge[12] = new() { Comirnaty, Boostrix, GardasilDose2, GardasilDose1, GardasilDose3 };
        return new DataEntryPopupViewModel(apiService, new NoOpClipboardService(), new NoOpPioneerEntrySequence(), pioneerWindowDetected: true);
    }

    private static async Task ContinueFromAge(DataEntryPopupViewModel viewModel, int age)
    {
        viewModel.PatientAgeYears = age;
        viewModel.ContinueFromAgeCommand.Execute(null);
        for (var i = 0; i < 50 && viewModel.IsBusy; i++)
        {
            await Task.Delay(10);
        }
    }

    [Fact]
    public async Task ContinueFromAgePopulatesGroupsInDisplayOrderAndAdvancesToGroupStage()
    {
        var viewModel = CreateViewModelWithEligibleVaccinesForAge12();

        await ContinueFromAge(viewModel, 12);

        Assert.Equal(DataEntryPopupViewModel.Stage.Group, viewModel.CurrentStage);
        // VaccineGroupCatalog.DisplayOrder lists COVID before
        // Tetanus/whooping cough before HPV — regardless of the input
        // list's own order (see the fixtures' deliberately scrambled order).
        Assert.Equal(new[] { "COVID", "Tetanus/whooping cough", "HPV" }, viewModel.AvailableGroups.ToArray());
    }

    [Fact]
    public async Task NoEligibleVaccinesForAgeStaysOnAgeStageWithAnErrorMessage()
    {
        var apiService = new FakeVaccineApiService(); // no entry for age 99 at all
        var viewModel = new DataEntryPopupViewModel(apiService, new NoOpClipboardService(), new NoOpPioneerEntrySequence(), pioneerWindowDetected: true);

        await ContinueFromAge(viewModel, 99);

        Assert.Equal(DataEntryPopupViewModel.Stage.Age, viewModel.CurrentStage);
        Assert.Contains("No active vaccine", viewModel.ErrorMessage);
    }

    [Fact]
    public async Task SelectingASingleDoseGroupGoesStraightToReviewWithThatVaccineSelected()
    {
        var viewModel = CreateViewModelWithEligibleVaccinesForAge12();
        await ContinueFromAge(viewModel, 12);

        viewModel.SelectGroup("Tetanus/whooping cough");
        Assert.Equal(DataEntryPopupViewModel.Stage.Product, viewModel.CurrentStage);
        var product = Assert.Single(viewModel.ProductOptions);
        Assert.Equal("Boostrix", product.Name);
        Assert.False(product.IsMultiDose);

        viewModel.SelectProduct(product);

        Assert.Equal(DataEntryPopupViewModel.Stage.Review, viewModel.CurrentStage);
        Assert.Equal(Boostrix, viewModel.SelectedVaccine);
    }

    [Fact]
    public async Task SelectingAMultiDoseGroupRequiresAnExtraDoseStepOrderedByDoseNumber()
    {
        var viewModel = CreateViewModelWithEligibleVaccinesForAge12();
        await ContinueFromAge(viewModel, 12);

        viewModel.SelectGroup("HPV");
        var product = Assert.Single(viewModel.ProductOptions);
        Assert.Equal("Gardasil", product.Name);
        Assert.True(product.IsMultiDose);
        // Ordered by dose number, not by the scrambled input order.
        Assert.Equal(new[] { "1", "2", "3" }, product.DoseRows.Select(v => v.Dose).ToArray());

        viewModel.SelectProduct(product);

        Assert.Equal(DataEntryPopupViewModel.Stage.Dose, viewModel.CurrentStage);
        Assert.Null(viewModel.SelectedVaccine); // not chosen yet -- still waiting on the dose answer
        Assert.Equal(new[] { "1", "2", "3" }, viewModel.DoseOptions.Select(v => v.Dose).ToArray());

        viewModel.SelectDose(viewModel.DoseOptions[1]); // dose "2"

        Assert.Equal(DataEntryPopupViewModel.Stage.Review, viewModel.CurrentStage);
        Assert.Equal(GardasilDose2, viewModel.SelectedVaccine);
    }

    [Fact]
    public async Task BackWalksThroughEveryStageInReverseAndClearsThatStagesSelection()
    {
        var viewModel = CreateViewModelWithEligibleVaccinesForAge12();
        await ContinueFromAge(viewModel, 12);
        viewModel.SelectGroup("HPV");
        var product = Assert.Single(viewModel.ProductOptions);
        viewModel.SelectProduct(product);
        viewModel.SelectDose(viewModel.DoseOptions[0]);
        Assert.Equal(DataEntryPopupViewModel.Stage.Review, viewModel.CurrentStage);

        viewModel.BackCommand.Execute(null); // Review -> Dose (multi-dose product)
        Assert.Equal(DataEntryPopupViewModel.Stage.Dose, viewModel.CurrentStage);
        Assert.Null(viewModel.SelectedVaccine);

        viewModel.BackCommand.Execute(null); // Dose -> Product
        Assert.Equal(DataEntryPopupViewModel.Stage.Product, viewModel.CurrentStage);
        Assert.Null(viewModel.SelectedProduct);
        Assert.Empty(viewModel.DoseOptions);

        viewModel.BackCommand.Execute(null); // Product -> Group
        Assert.Equal(DataEntryPopupViewModel.Stage.Group, viewModel.CurrentStage);
        Assert.Null(viewModel.SelectedGroup);
        Assert.Empty(viewModel.ProductOptions);
        // AvailableGroups survives a Product->Group back-step (only cleared on Group->Age).
        Assert.NotEmpty(viewModel.AvailableGroups);

        viewModel.BackCommand.Execute(null); // Group -> Age
        Assert.Equal(DataEntryPopupViewModel.Stage.Age, viewModel.CurrentStage);
        Assert.Empty(viewModel.AvailableGroups);

        Assert.False(viewModel.BackCommand.CanExecute(null)); // nowhere further back to go
    }

    [Fact]
    public async Task BackFromReviewForASingleDoseProductReturnsToProductNotDose()
    {
        var viewModel = CreateViewModelWithEligibleVaccinesForAge12();
        await ContinueFromAge(viewModel, 12);
        viewModel.SelectGroup("COVID");
        var product = Assert.Single(viewModel.ProductOptions);
        viewModel.SelectProduct(product); // single dose -- straight to Review
        Assert.Equal(DataEntryPopupViewModel.Stage.Review, viewModel.CurrentStage);

        viewModel.BackCommand.Execute(null);

        Assert.Equal(DataEntryPopupViewModel.Stage.Product, viewModel.CurrentStage);
    }
}
