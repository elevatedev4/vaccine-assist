using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Models;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// REST client for the cloud app's desktop-facing API
/// (cloud/app/api/vaccines, /lots, /eligibility/evaluate). Every call
/// requires an active sign-in (see IAuthService) — the cloud side
/// rejects requests with no valid bearer token.
/// </summary>
public interface IVaccineApiService
{
    Task<IReadOnlyList<Vaccine>> GetVaccinesAsync(CancellationToken cancellationToken = default);

    /// <summary>
    /// Calls GET /api/vaccines?includeInactive=true — the admin/full list
    /// for the desktop Active vaccines tab: every vaccine regardless of
    /// Active, each with HasActiveLot populated. Unlike GetVaccinesAsync,
    /// NOT active-only — do not use this for the Lots dropdown or the
    /// Data-entry popup's vaccine picker, both of which rely on
    /// GetVaccinesAsync staying active-only.
    /// </summary>
    Task<IReadOnlyList<Vaccine>> GetAllVaccinesAsync(CancellationToken cancellationToken = default);

    /// <summary>
    /// Calls PATCH /api/vaccines/{id} with {"active": active} to persist
    /// the Active vaccines tab's toggle. Returns the updated Vaccine.
    /// </summary>
    Task<Vaccine> SetVaccineActiveAsync(Guid id, bool active, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<Lot>> GetLotsAsync(
        Guid? vaccineId = null,
        string? status = null,
        CancellationToken cancellationToken = default);

    Task<Lot> CreateLotAsync(
        Guid vaccineId,
        string lotNumber,
        DateOnly expiration,
        string status = "active",
        string? note = null,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Calls PATCH /api/lots/{id} (cloud/app/api/lots/[id]/route.ts) —
    /// edits an existing lot's editable fields. Backs the Lots screen's
    /// inline-editable DataGrid (MSG893 item 4: lot number/expiration/
    /// beyond-use date/note, autosaved on cell-edit-end). Always sends
    /// all four editable fields (not a partial patch) so each call is a
    /// complete, self-consistent snapshot of the row at the moment it was
    /// committed — see LotRowViewModel's own doc comment for why that
    /// matters when two edits to the same row race. beyondUseDate is
    /// nullable both ways: null clears it, a value sets/replaces it — the
    /// cloud route distinguishes "field omitted" from "field explicitly
    /// null" by JSON key presence, and this always includes the key.
    /// </summary>
    Task<Lot> UpdateLotAsync(
        Guid id,
        string lotNumber,
        DateOnly expiration,
        DateOnly? beyondUseDate,
        string? note,
        CancellationToken cancellationToken = default);

    Task<EligibilityResult> EvaluateEligibilityAsync(
        Guid vaccineId,
        int ageYears,
        bool? isPregnant = null,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Calls GET /api/eligibility/for-age?age=N — every ACTIVE vaccine
    /// whose eligibility rules don't block that age (status "allowed" or
    /// "warning"; same "warning is staff judgment, not a hard stop"
    /// convention DataEntryGate documents), each with Vaccine.Eligibility
    /// populated. Backs the data-entry popup's guided flow (age -> group ->
    /// product -> dose — see DataEntryPopupViewModel.ContinueFromAgeAsync):
    /// computing "every vaccine eligible for age N" via GetVaccinesAsync
    /// plus one EvaluateEligibilityAsync call per vaccine would be N round
    /// trips for a ~30-vaccine formulary; this is one.
    /// </summary>
    Task<IReadOnlyList<Vaccine>> GetEligibleVaccinesForAgeAsync(
        int ageYears,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Calls GET /api/acuity/poll (default range: today .. today+7) for
    /// the Scheduling tab — see cloud/app/api/acuity/poll/route.ts's
    /// RESPONSE CONTRACT doc comment for the JSON shape this maps to.
    /// Returns Configured=false (not an exception) when Acuity isn't set
    /// up yet on the cloud side; that's a normal, expected state, not an
    /// error.
    /// </summary>
    Task<AppointmentScheduleResult> GetAppointmentScheduleAsync(CancellationToken cancellationToken = default);

    /// <summary>
    /// Calls GET /api/ordering/recommendation for the Ordering tab — see
    /// cloud/app/api/ordering/recommendation/route.ts's RESPONSE CONTRACT
    /// doc comment for the JSON shape this maps to. Unlike
    /// GetAppointmentScheduleAsync, there's no Configured=false state
    /// here: the route always returns a row per active vaccine (upcoming7d
    /// falls back to 0 when Acuity isn't configured yet), so an empty/zero
    /// result is a normal response, not an error.
    /// </summary>
    Task<OrderingRecommendationResult> GetOrderingRecommendationAsync(CancellationToken cancellationToken = default);

    /// <summary>Calls GET /api/physicians — every protocol physician on
    /// file, for the Physicians settings tab.</summary>
    Task<IReadOnlyList<Physician>> GetPhysiciansAsync(CancellationToken cancellationToken = default);

    /// <summary>Calls POST /api/physicians. displayName/alternateId must
    /// be non-empty; alternateId must not contain spaces (Pioneer's own
    /// Alternate ID rule, see the Physicians tab's info tooltip).</summary>
    Task<Physician> CreatePhysicianAsync(string displayName, string alternateId, CancellationToken cancellationToken = default);

    /// <summary>Calls DELETE /api/physicians/{id}.</summary>
    Task DeletePhysicianAsync(Guid id, CancellationToken cancellationToken = default);

    /// <summary>
    /// Calls GET /api/physician-rules — every vaccine/age-range -> physician
    /// assignment rule, for the Physicians settings tab, PLUS (reviewer
    /// fix, 2026-09-07) whether the server currently supports
    /// physician_rule.vaccine_group (see PhysicianRulesResult's own doc
    /// comment — a parallel migration/cloud branch added this flag for a
    /// real safety reason: a group-intent rule saved against a database
    /// missing that column silently becomes an unrestricted "any vaccine"
    /// wildcard). PhysiciansViewModel gates its entire "All &lt;group&gt;
    /// vaccines" ComboBox option list on this flag.
    /// </summary>
    Task<PhysicianRulesResult> GetPhysicianRulesAsync(CancellationToken cancellationToken = default);

    /// <summary>Calls POST /api/physician-rules. vaccineId null means
    /// "any vaccine" (the wildcard/"everything else" fallback rule) unless
    /// vaccineGroup is set, in which case it means "any vaccine in that
    /// VaccineGroupCatalog group" (Will, 2026-09-07 — see
    /// Models/PhysicianRuleMatcher.cs for the specific &gt; group &gt;
    /// wildcard precedence this enables). vaccineGroup is ignored/should be
    /// null whenever vaccineId is set.</summary>
    Task<PhysicianRule> CreatePhysicianRuleAsync(
        Guid physicianId,
        Guid? vaccineId,
        int? minAge,
        int? maxAge,
        int priority = 0,
        string? vaccineGroup = null,
        CancellationToken cancellationToken = default);

    /// <summary>Calls DELETE /api/physician-rules/{id}.</summary>
    Task DeletePhysicianRuleAsync(Guid id, CancellationToken cancellationToken = default);

    /// <summary>
    /// Calls GET /api/physicians/resolve?vaccineId=&amp;ageYears= — the
    /// single protocol physician whose rule covers this vaccine + age, or
    /// null when no rule matches. Called from
    /// DataEntryPopupViewModel.BuildLivePayloadAsync before every live
    /// PioneerRx entry; a null result blocks the entry with a message
    /// pointing at the Physicians settings tab rather than typing an
    /// unconfirmed alternate ID into a real patient's chart.
    /// </summary>
    Task<Physician?> ResolvePhysicianAsync(Guid vaccineId, int ageYears, CancellationToken cancellationToken = default);
}
