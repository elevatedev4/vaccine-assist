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
}
