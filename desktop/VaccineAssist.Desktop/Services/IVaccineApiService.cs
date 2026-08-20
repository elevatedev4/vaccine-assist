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

    Task<EligibilityResult> EvaluateEligibilityAsync(
        Guid vaccineId,
        int ageYears,
        bool? isPregnant = null,
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
}
