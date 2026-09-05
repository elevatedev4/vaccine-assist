using System;
using System.Collections.Specialized;
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

    // ------------------------------------------------------------------
    // BLOCKER 2 regressions (reviewer request-changes round): every
    // back-step that re-enters a RadioButton stage must rebuild that
    // stage's ObservableCollection (Reset then Add), not merely clear the
    // VM's selection field — otherwise WPF's existing RadioButton
    // containers stay IsChecked=true and never raise Checked again on a
    // re-click (single-option stages like HPV -> Gardasil become
    // unpassable after Back). These tests confirm the Reset+Add sequence
    // actually fires and that re-selecting afterward still transitions
    // stages correctly — see GoBack's doc comment for what this CANNOT
    // prove (an actual RadioButton's on-screen checked state and a real
    // mouse click firing Checked need a live WPF run to confirm).
    // ------------------------------------------------------------------

    [Fact]
    public async Task BackFromProductRebuildsAvailableGroupsSoTheSameGroupCanBeReselected()
    {
        var viewModel = CreateViewModelWithEligibleVaccinesForAge12();
        await ContinueFromAge(viewModel, 12);
        viewModel.SelectGroup("HPV");
        Assert.Equal(DataEntryPopupViewModel.Stage.Product, viewModel.CurrentStage);

        var events = new System.Collections.Generic.List<NotifyCollectionChangedAction>();
        viewModel.AvailableGroups.CollectionChanged += (_, e) => events.Add(e.Action);

        viewModel.BackCommand.Execute(null); // Product -> Group

        Assert.Contains(NotifyCollectionChangedAction.Reset, events);
        Assert.Contains(NotifyCollectionChangedAction.Add, events);
        Assert.Equal(new[] { "COVID", "Tetanus/whooping cough", "HPV" }, viewModel.AvailableGroups.ToArray());

        // Re-picking the exact same group that was selected before Back
        // must still work like a first-time pick.
        viewModel.SelectGroup("HPV");
        Assert.Equal(DataEntryPopupViewModel.Stage.Product, viewModel.CurrentStage);
        Assert.Equal("Gardasil", Assert.Single(viewModel.ProductOptions).Name);
    }

    [Fact]
    public async Task BackFromDoseRebuildsProductOptionsSoTheSameProductCanBeReselected()
    {
        var viewModel = CreateViewModelWithEligibleVaccinesForAge12();
        await ContinueFromAge(viewModel, 12);
        viewModel.SelectGroup("HPV");
        var product = Assert.Single(viewModel.ProductOptions);
        viewModel.SelectProduct(product); // multi-dose -> Dose stage
        Assert.Equal(DataEntryPopupViewModel.Stage.Dose, viewModel.CurrentStage);

        var events = new System.Collections.Generic.List<NotifyCollectionChangedAction>();
        viewModel.ProductOptions.CollectionChanged += (_, e) => events.Add(e.Action);

        viewModel.BackCommand.Execute(null); // Dose -> Product

        Assert.Contains(NotifyCollectionChangedAction.Reset, events);
        Assert.Contains(NotifyCollectionChangedAction.Add, events);
        var rebuiltProduct = Assert.Single(viewModel.ProductOptions);
        Assert.Equal("Gardasil", rebuiltProduct.Name);

        // Re-picking the SAME (only) product after Back must re-enter the
        // Dose stage again, not silently no-op.
        viewModel.SelectProduct(rebuiltProduct);
        Assert.Equal(DataEntryPopupViewModel.Stage.Dose, viewModel.CurrentStage);
    }

    [Fact]
    public async Task BackFromReviewForAMultiDoseProductRebuildsDoseOptions()
    {
        var viewModel = CreateViewModelWithEligibleVaccinesForAge12();
        await ContinueFromAge(viewModel, 12);
        viewModel.SelectGroup("HPV");
        var product = Assert.Single(viewModel.ProductOptions);
        viewModel.SelectProduct(product);
        viewModel.SelectDose(viewModel.DoseOptions[1]); // dose "2" -> Review
        Assert.Equal(DataEntryPopupViewModel.Stage.Review, viewModel.CurrentStage);

        var events = new System.Collections.Generic.List<NotifyCollectionChangedAction>();
        viewModel.DoseOptions.CollectionChanged += (_, e) => events.Add(e.Action);

        viewModel.BackCommand.Execute(null); // Review -> Dose

        Assert.Contains(NotifyCollectionChangedAction.Reset, events);
        Assert.Contains(NotifyCollectionChangedAction.Add, events);
        Assert.Equal(new[] { "1", "2", "3" }, viewModel.DoseOptions.Select(v => v.Dose).ToArray());

        // Re-picking the SAME dose ("2") that was chosen before Back must
        // still re-select it, not silently no-op.
        viewModel.SelectDose(viewModel.DoseOptions[1]);
        Assert.Equal(DataEntryPopupViewModel.Stage.Review, viewModel.CurrentStage);
        Assert.Equal(GardasilDose2, viewModel.SelectedVaccine);
    }

    [Fact]
    public async Task BackFromReviewForASingleDoseProductRebuildsProductOptions()
    {
        var viewModel = CreateViewModelWithEligibleVaccinesForAge12();
        await ContinueFromAge(viewModel, 12);
        viewModel.SelectGroup("Tetanus/whooping cough");
        var product = Assert.Single(viewModel.ProductOptions);
        viewModel.SelectProduct(product); // single dose -> straight to Review
        Assert.Equal(DataEntryPopupViewModel.Stage.Review, viewModel.CurrentStage);

        var events = new System.Collections.Generic.List<NotifyCollectionChangedAction>();
        viewModel.ProductOptions.CollectionChanged += (_, e) => events.Add(e.Action);

        viewModel.BackCommand.Execute(null); // Review -> Product

        Assert.Contains(NotifyCollectionChangedAction.Reset, events);
        Assert.Contains(NotifyCollectionChangedAction.Add, events);
        var rebuiltProduct = Assert.Single(viewModel.ProductOptions);
        Assert.Equal("Boostrix", rebuiltProduct.Name);

        // Re-picking the SAME single option after Back — the exact
        // "HPV -> Gardasil"/"Shingles -> Shingrix dead end" shape the
        // reviewer flagged — must reselect it, not silently no-op.
        viewModel.SelectProduct(rebuiltProduct);
        Assert.Equal(DataEntryPopupViewModel.Stage.Review, viewModel.CurrentStage);
        Assert.Equal(Boostrix, viewModel.SelectedVaccine);
    }
}
