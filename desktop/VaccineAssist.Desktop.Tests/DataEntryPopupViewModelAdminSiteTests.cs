using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.Services;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Unit tests for DataEntryPopupViewModel's AdminSite defaulting/toggle —
/// Will's feedback (2026-08-19): "Hide Admin site ... always default it
/// to Left Arm ... keep a way to switch to Right if trivial." The popup UI
/// itself (DataEntryPopupWindow.xaml's CheckBox) isn't testable without a
/// live WPF runtime, but the ViewModel state it binds to is — this covers
/// the actual defaulting/toggle logic. None of these tests exercise
/// LoadAsync/ValidateAsync/etc., so the fakes below only need to satisfy
/// the constructor's dependencies, not behave realistically.
/// </summary>
public class DataEntryPopupViewModelAdminSiteTests
{
    private static DataEntryPopupViewModel CreateViewModel() =>
        new(new NotUsedVaccineApiService(), new NotUsedClipboardService(), new NotUsedPioneerEntrySequence(), pioneerWindowDetected: true);

    [Fact]
    public void DefaultsToLeftArmOnConstruction()
    {
        var viewModel = CreateViewModel();

        Assert.Equal(AdminSite.LeftArm, viewModel.AdminSite);
        Assert.False(viewModel.IsRightArm);
    }

    [Fact]
    public void EachNewPopupInstanceStartsAtLeftArmEvenIfAPriorInstanceWasSetToRight()
    {
        // Mirrors MainWindow.ShowDataEntryPopup constructing a brand new
        // DataEntryPopupViewModel every time the popup opens — AdminSite
        // must never carry a prior popup's Right-arm selection forward.
        var firstPopup = CreateViewModel();
        firstPopup.IsRightArm = true;
        Assert.Equal(AdminSite.RightArm, firstPopup.AdminSite);

        var secondPopup = CreateViewModel();

        Assert.Equal(AdminSite.LeftArm, secondPopup.AdminSite);
        Assert.False(secondPopup.IsRightArm);
    }

    [Fact]
    public void IsRightArmCheckedSetsAdminSiteToRightArm()
    {
        var viewModel = CreateViewModel();

        viewModel.IsRightArm = true;

        Assert.Equal(AdminSite.RightArm, viewModel.AdminSite);
    }

    [Fact]
    public void IsRightArmUncheckedSetsAdminSiteBackToLeftArm()
    {
        var viewModel = CreateViewModel();
        viewModel.IsRightArm = true;

        viewModel.IsRightArm = false;

        Assert.Equal(AdminSite.LeftArm, viewModel.AdminSite);
    }

    private sealed class NotUsedVaccineApiService : IVaccineApiService
    {
        public Task<IReadOnlyList<Vaccine>> GetVaccinesAsync(CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public Task<IReadOnlyList<Lot>> GetLotsAsync(Guid? vaccineId = null, string? status = null, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public Task<Lot> CreateLotAsync(Guid vaccineId, string lotNumber, DateOnly expiration, string status = "active", string? note = null, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public Task<EligibilityResult> EvaluateEligibilityAsync(Guid vaccineId, int ageYears, bool? isPregnant = null, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public Task<AppointmentScheduleResult> GetAppointmentScheduleAsync(CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();
    }

    private sealed class NotUsedClipboardService : IClipboardService
    {
        public void SetText(string text) => throw new NotSupportedException();
    }

    private sealed class NotUsedPioneerEntrySequence : IPioneerEntrySequence
    {
        public string Name => throw new NotSupportedException();
        public IReadOnlyList<IPioneerEntryStep> Steps => throw new NotSupportedException();
    }
}
