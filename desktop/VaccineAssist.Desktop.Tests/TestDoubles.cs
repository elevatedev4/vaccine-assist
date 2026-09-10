using System;
using System.Collections.Generic;
using System.Linq;
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

    /// <summary>Backs GetAllVaccinesAsync — MSG893 item 4: LotsViewModel
    /// now joins vaccine name/NDC into each lot row via this (see that
    /// class's own doc comment for why it deliberately queries ALL
    /// vaccines, not just Vaccines above). Empty by default; tests that
    /// don't exercise LotsViewModel/VaccinesViewModel never need to touch
    /// this at all.</summary>
    public List<Vaccine> AllVaccines { get; } = new();

    public Dictionary<int, List<Vaccine>> EligibleVaccinesByAge { get; } = new();
    public Dictionary<Guid, List<Lot>> LotsByVaccineId { get; } = new();
    public EligibilityResult EvaluateEligibilityResult { get; set; } = new() { Status = "allowed" };
    public int EvaluateEligibilityCallCount { get; private set; }
    public List<(Guid VaccineId, string LotNumber, DateOnly Expiration, string? Note)> CreatedLots { get; } = new();

    /// <summary>Records every UpdateLotAsync call (MSG893 item 4's
    /// autosave). Set UpdateLotException to make the next call(s) throw,
    /// for revert-on-failure coverage.</summary>
    public List<(Guid Id, string LotNumber, DateOnly Expiration, DateOnly? BeyondUseDate, string? Note)> UpdatedLots { get; } = new();
    public Exception? UpdateLotException { get; set; }

    /// <summary>Records every DeleteLotAsync call (V-T21 item 5: "Update
    /// current lots to this lot" deletes the vaccine's other lots). Set
    /// DeleteLotException to make the next call(s) throw.</summary>
    public List<Guid> DeletedLotIds { get; } = new();
    public Exception? DeleteLotException { get; set; }

    /// <summary>
    /// Defaults to a resolved physician so every EXISTING test that
    /// exercises BuildPayloadAsync/EnterIntoPioneerAsync (written before
    /// the physician-resolution gate existed) keeps passing unchanged —
    /// only tests specifically covering the "no physician configured"
    /// block need to set this to null. See
    /// PhysicianResolutionGateTests.cs.
    /// </summary>
    public Physician? ResolvePhysicianResult { get; set; } = new() { Id = Guid.NewGuid(), DisplayName = "Rivera, Ana", AlternateId = "ALTTEST" };
    public int ResolvePhysicianCallCount { get; private set; }

    public Task<IReadOnlyList<Vaccine>> GetVaccinesAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<Vaccine>>(Vaccines);

    public Task<IReadOnlyList<Vaccine>> GetAllVaccinesAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<Vaccine>>(AllVaccines);

    public Task<Vaccine> SetVaccineActiveAsync(Guid id, bool active, CancellationToken cancellationToken = default) =>
        throw new NotSupportedException();

    /// <summary>Records every UpdateVaccineQuantityAsync/
    /// UpdateVaccineDirectionsAsync call (V-..., 2026-09-10: the
    /// blank-quantity/blank-directions prompt's "save it back" step) —
    /// same recording pattern as CreatedLots/UpdatedLots above. Set
    /// UpdateVaccineFieldException to make the next call throw, for
    /// "a failed save must not abort the entry" coverage.</summary>
    public List<(Guid Id, string Quantity)> SavedQuantities { get; } = new();
    public List<(Guid Id, string Directions)> SavedDirections { get; } = new();
    public Exception? UpdateVaccineFieldException { get; set; }

    public Task<Vaccine> UpdateVaccineQuantityAsync(Guid id, string quantity, CancellationToken cancellationToken = default)
    {
        if (UpdateVaccineFieldException is not null) throw UpdateVaccineFieldException;
        SavedQuantities.Add((id, quantity));
        return Task.FromResult(new Vaccine { Id = id, Quantity = quantity });
    }

    public Task<Vaccine> UpdateVaccineDirectionsAsync(Guid id, string directions, CancellationToken cancellationToken = default)
    {
        if (UpdateVaccineFieldException is not null) throw UpdateVaccineFieldException;
        SavedDirections.Add((id, directions));
        return Task.FromResult(new Vaccine { Id = id, Directions = directions });
    }

    public Task<IReadOnlyList<Vaccine>> GetEligibleVaccinesForAgeAsync(int ageYears, CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<Vaccine>>(
            EligibleVaccinesByAge.TryGetValue(ageYears, out var list) ? list : new List<Vaccine>());

    /// <summary>Set to make the very NEXT GetLotsAsync call suspend (await
    /// this) AFTER capturing its snapshot of LotsByVaccineId but BEFORE
    /// returning — lets a test simulate an older, slower network response
    /// that finally arrives AFTER a newer call already completed, to prove
    /// a race guard (e.g. DataEntryPopupViewModel's _lotRefreshToken)
    /// correctly ignores it. Consumed (reset to null) the moment it's
    /// used, so only the one targeted call is delayed.</summary>
    public TaskCompletionSource<bool>? DelayNextGetLotsCall { get; set; }

    /// <summary>vaccineId == null means "every lot across every vaccine"
    /// (MSG893 item 4: LotsViewModel.LoadAsync's unfiltered call) — a real
    /// status filter is applied here too now (previously ignored), which
    /// is harmless for every existing caller since every test-authored Lot
    /// defaults to Status="active" already.</summary>
    public async Task<IReadOnlyList<Lot>> GetLotsAsync(Guid? vaccineId = null, string? status = null, CancellationToken cancellationToken = default)
    {
        // Snapshot BEFORE any gating delay — a genuinely stale/slow
        // response reflects the data as it was AT CALL TIME, not
        // whatever it's since become while this call sat suspended.
        IEnumerable<Lot> lots = vaccineId is Guid id
            ? (LotsByVaccineId.TryGetValue(id, out var list) ? list.ToList() : new List<Lot>())
            : LotsByVaccineId.Values.SelectMany(l => l).ToList();

        var gate = DelayNextGetLotsCall;
        if (gate is not null)
        {
            DelayNextGetLotsCall = null;
            await gate.Task;
        }

        if (!string.IsNullOrWhiteSpace(status))
        {
            lots = lots.Where(l => string.Equals(l.Status, status, StringComparison.OrdinalIgnoreCase));
        }

        return lots.ToList();
    }

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

    public Task<Lot> UpdateLotAsync(
        Guid id, string lotNumber, DateOnly expiration, DateOnly? beyondUseDate, string? note,
        CancellationToken cancellationToken = default)
    {
        if (UpdateLotException is not null) throw UpdateLotException;

        UpdatedLots.Add((id, lotNumber, expiration, beyondUseDate, note));

        var existing = LotsByVaccineId.Values.SelectMany(l => l).FirstOrDefault(l => l.Id == id);
        if (existing is not null)
        {
            existing.LotNumber = lotNumber;
            existing.Expiration = expiration;
            existing.BeyondUseDate = beyondUseDate;
            existing.Note = note;
            return Task.FromResult(existing);
        }

        return Task.FromResult(new Lot { Id = id, LotNumber = lotNumber, Expiration = expiration, BeyondUseDate = beyondUseDate, Note = note, Status = "active" });
    }

    public Task DeleteLotAsync(Guid id, CancellationToken cancellationToken = default)
    {
        if (DeleteLotException is not null) throw DeleteLotException;

        DeletedLotIds.Add(id);
        foreach (var list in LotsByVaccineId.Values)
        {
            list.RemoveAll(l => l.Id == id);
        }
        return Task.CompletedTask;
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

    // In-memory-backed (not throw-only like the untouched members above) —
    // PhysiciansViewModelTests exercises the Physicians settings tab's
    // full load/add/delete round trip against these, same reasoning as
    // LotsByVaccineId/CreatedLots above.
    public List<Physician> PhysicianRows { get; } = new();
    public List<PhysicianRule> PhysicianRuleRows { get; } = new();

    /// <summary>Defaults to true so every EXISTING test that loads
    /// physician rules (written before the reviewer's vaccineGroupSupported
    /// safety fix existed) keeps passing unchanged — only tests
    /// specifically covering the "migration hasn't run yet, hide group
    /// options" case need to set this false. See
    /// PhysiciansViewModelVaccineGroupSupportTests.cs.</summary>
    public bool VaccineGroupSupported { get; set; } = true;

    public Task<IReadOnlyList<Physician>> GetPhysiciansAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<Physician>>(PhysicianRows);

    public Task<Physician> CreatePhysicianAsync(string displayName, string alternateId, CancellationToken cancellationToken = default)
    {
        var physician = new Physician { Id = Guid.NewGuid(), DisplayName = displayName, AlternateId = alternateId };
        PhysicianRows.Add(physician);
        return Task.FromResult(physician);
    }

    public Task DeletePhysicianAsync(Guid id, CancellationToken cancellationToken = default)
    {
        PhysicianRows.RemoveAll(p => p.Id == id);
        PhysicianRuleRows.RemoveAll(r => r.PhysicianId == id); // mirrors the real FK cascade-delete
        return Task.CompletedTask;
    }

    public Task<PhysicianRulesResult> GetPhysicianRulesAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult(new PhysicianRulesResult(PhysicianRuleRows, VaccineGroupSupported));

    public Task<PhysicianRule> CreatePhysicianRuleAsync(
        Guid physicianId, Guid? vaccineId, int? minAge, int? maxAge, int priority = 0, string? vaccineGroup = null,
        CancellationToken cancellationToken = default)
    {
        var rule = new PhysicianRule
        {
            Id = Guid.NewGuid(),
            PhysicianId = physicianId,
            VaccineId = vaccineId,
            VaccineGroup = vaccineGroup,
            MinAge = minAge,
            MaxAge = maxAge,
            Priority = priority,
        };
        PhysicianRuleRows.Add(rule);
        return Task.FromResult(rule);
    }

    public Task DeletePhysicianRuleAsync(Guid id, CancellationToken cancellationToken = default)
    {
        PhysicianRuleRows.RemoveAll(r => r.Id == id);
        return Task.CompletedTask;
    }

    public Task<Physician?> ResolvePhysicianAsync(Guid vaccineId, int ageYears, CancellationToken cancellationToken = default)
    {
        ResolvePhysicianCallCount++;
        return Task.FromResult(ResolvePhysicianResult);
    }
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
