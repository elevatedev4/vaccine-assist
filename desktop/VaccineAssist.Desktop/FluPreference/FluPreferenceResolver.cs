using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.Services;

namespace VaccineAssist.Desktop.FluPreference;

/// <summary>The preferred product, ready to enter: its catalog row, its current lot, and the macro text that makes the existing entry automation use it.</summary>
public sealed record PreferredFluChoice(Vaccine Vaccine, Lot Lot, string MacroCode);

/// <summary>Either a ready-to-enter preferred product, or why it can't be entered (shown in the dialog).</summary>
public sealed record PreferredFluResult(PreferredFluChoice? Choice, string? UnavailableReason)
{
    public bool IsAvailable => Choice is not null;
    public static PreferredFluResult Available(PreferredFluChoice choice) => new(choice, null);
    public static PreferredFluResult Unavailable(string reason) => new(null, reason);
}

/// <summary>
/// Turns a FluPreferencePrompt into something enterable: finds the preferred
/// product's active vaccine row (Flucelvax: flucelvaxmdv first, then
/// flucelvaxpfs) and its current lot, and builds the "code,lot,MMDDYYYY"
/// macro text MacroCodeParser expects. The lot MUST come from the preferred
/// product itself - the picked macro's lot belongs to the product that was
/// NOT chosen - so an expired, beyond-use or missing lot makes the preferred
/// product unavailable instead of entering a wrong or stale lot.
/// </summary>
public static class FluPreferenceResolver
{
    /// <summary>First ACTIVE vaccine matching the prompt's preferred short codes, in preference order. Null when none is on file/active.</summary>
    public static Vaccine? FindPreferredVaccine(IEnumerable<Vaccine> vaccines, FluPreferencePrompt prompt)
    {
        var active = vaccines.Where(v => v.Active).ToList();
        foreach (var code in prompt.PreferredShortCodes)
        {
            var match = active.FirstOrDefault(v =>
                string.Equals((v.ShortCode ?? "").Trim(), code, StringComparison.OrdinalIgnoreCase));
            if (match is not null) return match;
        }
        return null;
    }

    /// <summary>The vaccine's "current" lot, same rule as the cloud (lib/lots-table.ts pickCurrentActiveLot): earliest expiration first among active lots, no expiration last.</summary>
    public static Lot? PickCurrentLot(IEnumerable<Lot> lots) =>
        lots.Where(l => l.IsActive)
            .OrderBy(l => l.Expiration is null)
            .ThenBy(l => l.Expiration)
            .FirstOrDefault();

    /// <summary>Null when the lot is usable today; otherwise the reason it is not. Expired = before today; beyond-use = today or earlier (same boundaries as Lot.IsExpired / Lot.IsPastBeyondUseDate).</summary>
    public static string? LotProblem(Lot lot, DateOnly today)
    {
        if (string.IsNullOrWhiteSpace(lot.LotNumber)) return "its current lot has no lot number";
        if (lot.Expiration is not DateOnly expiration) return $"its current lot ({lot.LotNumber.Trim()}) has no expiration date";
        if (expiration < today) return $"its current lot ({lot.LotNumber.Trim()}) is expired";
        if (lot.BeyondUseDate is DateOnly bud && bud <= today) return $"its current lot ({lot.LotNumber.Trim()}) is past its beyond-use date";
        return null;
    }

    /// <summary>"shortcode,lot,MMDDYYYY" - the macro-codes text format (MacroCodeParser) for this vaccine and lot.</summary>
    public static string BuildSwappedMacroCode(Vaccine vaccine, Lot lot) =>
        $"{vaccine.ShortCode.Trim()},{lot.LotNumber.Trim()},{lot.ExpirationMacroFormat}";

    /// <summary>Looks up the preferred vaccine and its current lot. API errors propagate (the caller treats them as "unavailable").</summary>
    public static async Task<PreferredFluResult> ResolvePreferredAsync(
        IVaccineApiService api,
        FluPreferencePrompt prompt,
        DateOnly today,
        CancellationToken cancellationToken = default)
    {
        var vaccines = await api.GetVaccinesAsync(cancellationToken).ConfigureAwait(true);
        var vaccine = FindPreferredVaccine(vaccines, prompt);
        if (vaccine is null)
        {
            return PreferredFluResult.Unavailable($"{prompt.PreferredName} is not on file as an active vaccine.");
        }

        var lots = await api.GetLotsAsync(vaccine.Id, "active", cancellationToken).ConfigureAwait(true);
        var lot = PickCurrentLot(lots);
        if (lot is null)
        {
            return PreferredFluResult.Unavailable($"{prompt.PreferredName} has no active lot on file.");
        }

        var problem = LotProblem(lot, today);
        if (problem is not null)
        {
            return PreferredFluResult.Unavailable($"{prompt.PreferredName} can't be entered: {problem}.");
        }

        return PreferredFluResult.Available(new PreferredFluChoice(vaccine, lot, BuildSwappedMacroCode(vaccine, lot)));
    }
}
