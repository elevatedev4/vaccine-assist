using System;
using System.Collections.Generic;
using System.Linq;

namespace VaccineAssist.Desktop.FluPreference;

/// <summary>One of the three age-banded flu products and its age rules.</summary>
/// <param name="CodePrefix">Lower-case short-code prefix that identifies the product (any variant counts: flucelvaxmdv, flucelvaxpfs, ...).</param>
/// <param name="ApprovedMinAge">Approved from this age (years) up.</param>
/// <param name="PreferredMinAge">Preferred band start (years, inclusive).</param>
/// <param name="PreferredMaxAge">Preferred band end (years, inclusive); null = no upper limit.</param>
/// <param name="PreferredShortCodes">Vaccine short codes to enter when this product is the preferred one, in order of preference.</param>
public sealed record FluProduct(
    string DisplayName,
    string CodePrefix,
    int ApprovedMinAge,
    int PreferredMinAge,
    int? PreferredMaxAge,
    IReadOnlyList<string> PreferredShortCodes)
{
    public string PreferredBandText => PreferredMaxAge is int max
        ? $"{PreferredMinAge}–{max}"
        : $"{PreferredMinAge} and older";
}

/// <summary>
/// What the flu-preference dialog shows. SelectedName is what the pharmacist
/// picked; PreferredName/PreferredShortCodes is what the rules prefer at this
/// age; ApprovedNote is set only when the selected product is one of the
/// three and the patient's age is outside its approved range.
/// </summary>
public sealed record FluPreferencePrompt(
    int AgeYears,
    string SelectedName,
    string SelectedShortCode,
    string PreferredName,
    IReadOnlyList<string> PreferredShortCodes,
    string PreferredBandText,
    string? ApprovedNote);

/// <summary>
/// Will's flu rules (2026-10-18, verbatim): "Flucelvax is available for 3+
/// and most preferred for age 3-49, mflusiva is approved for 50+ and most
/// preferred for 50-64, fluad is approved for 65+ and preferred for 65+."
///
/// The rule DATA is the Products table below - the only place those numbers
/// live in the desktop app. They are Will's numbers even where other repo
/// data differs (macro catalog says Flucelvax 6 months+; the eligibility
/// seed says Fluad min age 18).
///
/// Pure (no WPF, no network): Evaluate(age, short code) returns null (no
/// prompt) or the prompt to show.
/// </summary>
public static class FluPreferenceRules
{
    /// <summary>Youngest age the rules cover; below this nothing is prompted.</summary>
    public const int MinimumRuleAge = 3;

    public static IReadOnlyList<FluProduct> Products { get; } = new[]
    {
        new FluProduct("Flucelvax", "flucelvax", ApprovedMinAge: 3,  PreferredMinAge: 3,  PreferredMaxAge: 49,   new[] { "flucelvaxmdv", "flucelvaxpfs" }),
        new FluProduct("mFLUSIVA",  "mflusiva",  ApprovedMinAge: 50, PreferredMinAge: 50, PreferredMaxAge: 64,   new[] { "mflusiva" }),
        new FluProduct("Fluad",     "fluad",     ApprovedMinAge: 65, PreferredMinAge: 65, PreferredMaxAge: null, new[] { "fluad" }),
    };

    /// <summary>
    /// True for any influenza vaccine short code: the three products above
    /// plus the others in the catalog (afluria*, fluzone*, flumist, fluarix*,
    /// flulaval, ...). Prefix test on the trimmed, lower-cased code: "flu",
    /// "aflu" (Afluria), "mflu" (mFLUSIVA).
    /// </summary>
    public static bool IsFluCode(string? shortCode)
    {
        var code = Normalize(shortCode);
        return code.StartsWith("flu", StringComparison.Ordinal)
            || code.StartsWith("aflu", StringComparison.Ordinal)
            || code.StartsWith("mflu", StringComparison.Ordinal);
    }

    /// <summary>The preferred product for an age, or null below the minimum rule age.</summary>
    public static FluProduct? PreferredFor(int ageYears)
    {
        if (ageYears < MinimumRuleAge) return null;
        return Products.FirstOrDefault(p =>
            ageYears >= p.PreferredMinAge && (p.PreferredMaxAge is not int max || ageYears <= max));
    }

    /// <summary>The three-product entry the short code belongs to (any Flucelvax variant is Flucelvax), or null.</summary>
    public static FluProduct? ProductFor(string? shortCode)
    {
        var code = Normalize(shortCode);
        if (code.Length == 0) return null;
        return Products.FirstOrDefault(p => code.StartsWith(p.CodePrefix, StringComparison.Ordinal));
    }

    /// <summary>
    /// No prompt (null) when: the code is not a flu code, the age is under 3,
    /// or the selected product already is the preferred one for the age.
    /// </summary>
    public static FluPreferencePrompt? Evaluate(int ageYears, string? selectedShortCode)
    {
        if (!IsFluCode(selectedShortCode)) return null;

        var preferred = PreferredFor(ageYears);
        if (preferred is null) return null;

        var selectedProduct = ProductFor(selectedShortCode);
        if (ReferenceEquals(selectedProduct, preferred)) return null;

        string? approvedNote = null;
        if (selectedProduct is not null && ageYears < selectedProduct.ApprovedMinAge)
        {
            approvedNote = $"{selectedProduct.DisplayName} is only approved for ages {selectedProduct.ApprovedMinAge} and older.";
        }

        var code = (selectedShortCode ?? "").Trim();
        return new FluPreferencePrompt(
            ageYears,
            selectedProduct?.DisplayName ?? FriendlyName(code),
            code,
            preferred.DisplayName,
            preferred.PreferredShortCodes,
            preferred.PreferredBandText,
            approvedNote);
    }

    /// <summary>Readable name for the flu products outside the three-product table; the raw code when unknown.</summary>
    public static string FriendlyName(string shortCode)
    {
        var code = Normalize(shortCode);
        if (code.StartsWith("afluria", StringComparison.Ordinal)) return "Afluria";
        if (code.StartsWith("fluzonehd", StringComparison.Ordinal)) return "Fluzone High-Dose";
        if (code.StartsWith("fluzone", StringComparison.Ordinal)) return "Fluzone";
        if (code.StartsWith("flumist", StringComparison.Ordinal)) return "FluMist";
        if (code.StartsWith("fluarix", StringComparison.Ordinal)) return "Fluarix";
        if (code.StartsWith("flulaval", StringComparison.Ordinal)) return "Flulaval";
        return shortCode.Trim();
    }

    private static string Normalize(string? shortCode) => (shortCode ?? "").Trim().ToLowerInvariant();
}
