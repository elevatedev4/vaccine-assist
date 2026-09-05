using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.Services;
using VaccineAssist.Desktop.Settings;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Hand-rolled fakes (no mocking framework — matches this repo's
/// dependency-light style) for the interfaces LoginViewModel depends on.
/// </summary>
internal sealed class FakeAuthService : IAuthService
{
    private readonly AuthResult _result;

    public FakeAuthService(AuthResult result)
    {
        _result = result;
    }

    public bool IsSignedIn { get; private set; }
    public string? AccessToken { get; private set; }
    public int SignInCallCount { get; private set; }
    public string? LastEmail { get; private set; }
    public string? LastPassword { get; private set; }

    public Task<AuthResult> SignInAsync(string email, string password)
    {
        SignInCallCount++;
        LastEmail = email;
        LastPassword = password;
        if (_result.Success)
        {
            IsSignedIn = true;
            AccessToken = "fake-token";
        }
        return Task.FromResult(_result);
    }

    public Task SignOutAsync()
    {
        IsSignedIn = false;
        AccessToken = null;
        return Task.CompletedTask;
    }
}

internal sealed class FakeLocalSettingsService : ILocalSettingsService
{
    private readonly AppSettings _settings;

    /// <summary>When set, Save() throws this instead of succeeding —
    /// regression coverage for the crash fix in LoginViewModel.SignInAsync
    /// (Will, 2026-08-19/20): a locked/unwritable settings.json on a real
    /// workstation must not stop sign-in from completing.</summary>
    public Exception? ThrowOnSave { get; set; }

    public FakeLocalSettingsService(AppSettings settings)
    {
        _settings = settings;
    }

    public int SaveCallCount { get; private set; }

    public AppSettings Load() => _settings;

    public void Save(AppSettings settings)
    {
        SaveCallCount++;
        if (ThrowOnSave is not null)
        {
            throw ThrowOnSave;
        }
    }
}

internal sealed class FakeAutoLoginConfigService : IAutoLoginConfigService
{
    private readonly AutoLoginConfig? _config;

    public FakeAutoLoginConfigService(AutoLoginConfig? config)
    {
        _config = config;
    }

    public AutoLoginConfig? Load() => _config;
}

/// <summary>
/// Configurable fake for the guided-flow (V-... Part B) and expiration-gate
/// (Part C) tests — richer than DataEntryPopupViewModelAutoValidateTests.cs's
/// own private fake (which only needs a fixed eligibility result and an
/// always-present unexpired lot). Every collection is a plain mutable field
/// a test populates directly; nothing here enforces call ordering or
/// validates arguments beyond what each test itself asserts on.
/// </summary>
internal sealed class FakeVaccineApiService : IVaccineApiService
{
    public List<Vaccine> Vaccines { get; } = new();
    public Dictionary<int, List<Vaccine>> EligibleVaccinesByAge { get; } = new();
    public Dictionary<Guid, List<Lot>> LotsByVaccineId { get; } = new();
    public EligibilityResult EvaluateEligibilityResult { get; set; } = new() { Status = "allowed" };
    public int EvaluateEligibilityCallCount { get; private set; }
    public List<(Guid VaccineId, string LotNumber, DateOnly Expiration, string? Note)> CreatedLots { get; } = new();

    public Task<IReadOnlyList<Vaccine>> GetVaccinesAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<Vaccine>>(Vaccines);

    public Task<IReadOnlyList<Vaccine>> GetAllVaccinesAsync(CancellationToken cancellationToken = default) =>
        throw new NotSupportedException();

    public Task<Vaccine> SetVaccineActiveAsync(Guid id, bool active, CancellationToken cancellationToken = default) =>
        throw new NotSupportedException();

    public Task<IReadOnlyList<Vaccine>> GetEligibleVaccinesForAgeAsync(int ageYears, CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<Vaccine>>(
            EligibleVaccinesByAge.TryGetValue(ageYears, out var list) ? list : new List<Vaccine>());

    public Task<IReadOnlyList<Lot>> GetLotsAsync(Guid? vaccineId = null, string? status = null, CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<Lot>>(
            vaccineId is Guid id && LotsByVaccineId.TryGetValue(id, out var lots) ? lots : new List<Lot>());

    public Task<Lot> CreateLotAsync(
        Guid vaccineId, string lotNumber, DateOnly expiration, string status = "active", string? note = null,
        CancellationToken cancellationToken = default)
    {
        CreatedLots.Add((vaccineId, lotNumber, expiration, note));
        var lot = new Lot { Id = Guid.NewGuid(), VaccineId = vaccineId, LotNumber = lotNumber, Expiration = expiration, Status = status, Note = note };

        if (!LotsByVaccineId.TryGetValue(vaccineId, out var list))
        {
            list = new List<Lot>();
            LotsByVaccineId[vaccineId] = list;
        }
        list.Add(lot);

        return Task.FromResult(lot);
    }

    public Task<EligibilityResult> EvaluateEligibilityAsync(Guid vaccineId, int ageYears, bool? isPregnant = null, CancellationToken cancellationToken = default)
    {
        EvaluateEligibilityCallCount++;
        return Task.FromResult(EvaluateEligibilityResult);
    }

    public Task<AppointmentScheduleResult> GetAppointmentScheduleAsync(CancellationToken cancellationToken = default) =>
        throw new NotSupportedException();

    public Task<OrderingRecommendationResult> GetOrderingRecommendationAsync(CancellationToken cancellationToken = default) =>
        throw new NotSupportedException();
}

internal sealed class NoOpClipboardService : IClipboardService
{
    public void SetText(string text) { }
}

internal sealed class NoOpPioneerEntrySequence : IPioneerEntrySequence
{
    public string Name => "no-op";
    public IReadOnlyList<IPioneerEntryStep> Steps { get; } = new List<IPioneerEntryStep>();
}

/// <summary>
/// One-step sequence that records the PioneerEntryStepContext.Payload it
/// was run with and always succeeds — used by
/// DataEntryPopupViewModelExpirationGateTests.cs to prove
/// VaccineEntryPayload.SkipLotAndExpiration (V-... Part C) actually reaches
/// the sequence runner, not just DataEntryPopupViewModel's own state.
/// NoOpPioneerEntrySequence above can't be used for that: an EMPTY Steps
/// list makes PioneerEntrySequenceResult.Success false (Count > 0 is part
/// of that check), so it can't stand in for "a normal successful run."
/// </summary>
internal sealed class PayloadCapturingPioneerEntrySequence : IPioneerEntrySequence
{
    public string Name => "payload-capturing";
    public VaccineEntryPayload? CapturedPayload { get; private set; }
    public IReadOnlyList<IPioneerEntryStep> Steps { get; }

    public PayloadCapturingPioneerEntrySequence()
    {
        Steps = new IPioneerEntryStep[] { new CaptureStep(this) };
    }

    private sealed class CaptureStep : IPioneerEntryStep
    {
        private readonly PayloadCapturingPioneerEntrySequence _owner;
        public CaptureStep(PayloadCapturingPioneerEntrySequence owner) => _owner = owner;
        public string Name => "capture";

        public Task<PioneerEntryStepResult> ExecuteAsync(
            PioneerEntryStepContext context, CancellationToken cancellationToken = default)
        {
            _owner.CapturedPayload = context.Payload;
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: true, context.DryRun, "captured"));
        }
    }
}
