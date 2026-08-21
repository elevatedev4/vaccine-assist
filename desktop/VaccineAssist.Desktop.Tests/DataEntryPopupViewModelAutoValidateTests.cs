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
/// V-T3 item 4 (Will, 2026-08-19/20: "Remove Right Arm and Validate and
/// Dry run... We won't be using any of that right now"). The Validate
/// BUTTON is gone from DataEntryPopupWindow.xaml, but the eligibility
/// check it used to trigger is still a real safety gate (DataEntryGate
/// blocks "Enter into Pioneer" for an age-inappropriate vaccine) — see
/// DataEntryPopupViewModel's class doc comment for why that's kept
/// running automatically instead of removed outright. These tests cover
/// that automatic trigger, plus that AdminSite/IsDryRun are now fixed,
/// un-settable values with the Right-arm/Dry-run toggle properties gone
/// (superseding the deleted DataEntryPopupViewModelAdminSiteTests.cs).
/// </summary>
public class DataEntryPopupViewModelAutoValidateTests
{
    private static readonly Vaccine SampleVaccine = new()
    {
        Id = Guid.NewGuid(),
        Name = "MMR",
        ShortCode = "mmr1",
    };

    private static DataEntryPopupViewModel CreateViewModel(FakeVaccineApiService apiService, bool pioneerWindowDetected = true) =>
        new(apiService, new NoOpClipboardService(), new NoOpPioneerEntrySequence(), pioneerWindowDetected);

    [Fact]
    public async Task SettingVaccineThenAgeAutomaticallyRunsEligibilityCheck()
    {
        var apiService = new FakeVaccineApiService(EligibilityResultFactory.Allowed());
        var viewModel = CreateViewModel(apiService);

        viewModel.SelectedVaccine = SampleVaccine;
        Assert.Equal(0, apiService.EvaluateEligibilityCallCount); // age not set yet — nothing to validate

        viewModel.PatientAgeYears = 5;
        await WaitForBusyToSettle(viewModel);

        Assert.Equal(1, apiService.EvaluateEligibilityCallCount);
        Assert.NotNull(viewModel.EligibilityResult);
    }

    [Fact]
    public async Task SettingAgeThenVaccineAutomaticallyRunsEligibilityCheckToo()
    {
        var apiService = new FakeVaccineApiService(EligibilityResultFactory.Allowed());
        var viewModel = CreateViewModel(apiService);

        viewModel.PatientAgeYears = 5;
        Assert.Equal(0, apiService.EvaluateEligibilityCallCount); // vaccine not set yet

        viewModel.SelectedVaccine = SampleVaccine;
        await WaitForBusyToSettle(viewModel);

        Assert.Equal(1, apiService.EvaluateEligibilityCallCount);
    }

    [Fact]
    public async Task BlockedResultKeepsEnterIntoPioneerDisabled()
    {
        var apiService = new FakeVaccineApiService(EligibilityResultFactory.Blocked("Too young for this vaccine."));
        var viewModel = CreateViewModel(apiService);

        viewModel.SelectedVaccine = SampleVaccine;
        viewModel.PatientAgeYears = 1;
        await WaitForBusyToSettle(viewModel);

        Assert.False(viewModel.Gate.CanEnterIntoPioneer);
        Assert.Equal("Too young for this vaccine.", viewModel.Gate.BlockMessage);
        Assert.False(viewModel.EnterIntoPioneerCommand.CanExecute(null));
    }

    [Fact]
    public async Task AllowedResultEnablesEnterIntoPioneer()
    {
        var apiService = new FakeVaccineApiService(EligibilityResultFactory.Allowed());
        var viewModel = CreateViewModel(apiService);

        viewModel.SelectedVaccine = SampleVaccine;
        viewModel.PatientAgeYears = 12;
        await WaitForBusyToSettle(viewModel);

        Assert.True(viewModel.Gate.CanEnterIntoPioneer);
        Assert.True(viewModel.EnterIntoPioneerCommand.CanExecute(null));
    }

    [Fact]
    public void AdminSiteIsAlwaysLeftArmWithNoWayToOverrideIt()
    {
        // Right arm checkbox is gone entirely (Will, 2026-08-19/20) —
        // AdminSite has no public setter any more.
        var viewModel = CreateViewModel(new FakeVaccineApiService(EligibilityResultFactory.Allowed()));

        Assert.Equal(AdminSite.LeftArm, viewModel.AdminSite);
    }

    [Fact]
    public void IsDryRunReflectsPioneerDetectionAndCannotBeToggled()
    {
        // Dry run checkbox is gone entirely — IsDryRun is fixed for the
        // life of the popup from the constructor's pioneerWindowDetected.
        var detected = CreateViewModel(new FakeVaccineApiService(EligibilityResultFactory.Allowed()), pioneerWindowDetected: true);
        var notDetected = CreateViewModel(new FakeVaccineApiService(EligibilityResultFactory.Allowed()), pioneerWindowDetected: false);

        Assert.False(detected.IsDryRun);
        Assert.True(notDetected.IsDryRun);
    }

    private static async Task WaitForBusyToSettle(DataEntryPopupViewModel viewModel)
    {
        // TryAutoValidate fires AsyncRelayCommand.Execute (async void) —
        // give its Task a turn to complete before asserting.
        for (var i = 0; i < 50 && viewModel.IsBusy; i++)
        {
            await Task.Delay(10);
        }
    }

    private static class EligibilityResultFactory
    {
        public static EligibilityResult Allowed() => new() { Status = "allowed", Reasons = new List<string>(), Warnings = new List<string>() };
        public static EligibilityResult Blocked(string reason) => new() { Status = "blocked", Reasons = new List<string> { reason }, Warnings = new List<string>() };
    }

    private sealed class FakeVaccineApiService : IVaccineApiService
    {
        private readonly EligibilityResult _result;

        public FakeVaccineApiService(EligibilityResult result) => _result = result;

        public int EvaluateEligibilityCallCount { get; private set; }

        public Task<IReadOnlyList<Vaccine>> GetVaccinesAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult<IReadOnlyList<Vaccine>>(new List<Vaccine> { SampleVaccine });

        public Task<IReadOnlyList<Vaccine>> GetAllVaccinesAsync(CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public Task<Vaccine> SetVaccineActiveAsync(Guid id, bool active, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public Task<IReadOnlyList<Lot>> GetLotsAsync(Guid? vaccineId = null, string? status = null, CancellationToken cancellationToken = default) =>
            Task.FromResult<IReadOnlyList<Lot>>(new List<Lot>());

        public Task<Lot> CreateLotAsync(Guid vaccineId, string lotNumber, DateOnly expiration, string status = "active", string? note = null, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public Task<EligibilityResult> EvaluateEligibilityAsync(Guid vaccineId, int ageYears, bool? isPregnant = null, CancellationToken cancellationToken = default)
        {
            EvaluateEligibilityCallCount++;
            return Task.FromResult(_result);
        }

        public Task<AppointmentScheduleResult> GetAppointmentScheduleAsync(CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();
    }

    private sealed class NoOpClipboardService : IClipboardService
    {
        public void SetText(string text) { }
    }

    private sealed class NoOpPioneerEntrySequence : IPioneerEntrySequence
    {
        public string Name => "no-op";
        public IReadOnlyList<IPioneerEntryStep> Steps { get; } = new List<IPioneerEntryStep>();
    }
}
