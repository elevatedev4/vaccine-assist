using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;
using VaccineAssist.Desktop.FluPreference;

namespace VaccineAssist.Desktop.Hotkeys;

/// <summary>What one pressed letter does on the macro-codes page: press <see cref="To"/> instead, or show <see cref="Notice"/>.</summary>
public sealed record HotkeyAction(string? To, string? Notice);

/// <summary>Product label (lower-case text match) whose underlined classic hotkey letter is replaced by a "[Key]" badge.</summary>
public sealed record HotkeyRelabel(string Match, string Key);

/// <summary>A product label (lower-case text) and the classic hotkey letter the page is expected to underline in it.</summary>
public sealed record ClassicLabel(string Match, string Letter);

/// <summary>Which classic key a PREFERRED COVID product has, and why.</summary>
public sealed record PreferredCovidChoice(string ClassicKey, string Label);

/// <summary>
/// Will's hotkeys (V-Q11, 2026-10-20, verbatim): "Update hotkeys. F picks the
/// recommended flu for that age. Flucelvax is X. Fluad is D. mFLUSIVA is V. C
/// chooses the preferred COVID vaccine based on the location settings ...
/// P and M still map to the Pfizer and Moderna." (2026-10-22: "pushing F or C
/// respectively should choose the preferred vaccine for their age, or in
/// COVID's case, the one we choose in settings, currently Comirnaty.")
///
/// The cloud macro-codes page of the deployed (rolled-back) cloud only knows
/// the CLASSIC letters (F Flucelvax, L mFLUSIVA, D Fluad, C Capvaxive, V Vaqta,
/// P Pfizer, M Moderna, 3 Moderna kids). This plan translates the new keys to
/// those classic letters per patient, so the Testing desktop gets the new
/// hotkeys without any cloud change; the page is told nothing new and a later
/// cloud deploy changes nothing here. Pure: the page script is generated from
/// this plan (<see cref="Flu2HotkeyScript"/>), and the plan itself is tested.
/// </summary>
public sealed class Flu2HotkeyPlan
{
    /// <summary>Classic key of each flu product (cloud lib/macro-hotkeys.ts MACRO_HOTKEYS), by FluProduct.CodePrefix.</summary>
    private static readonly Dictionary<string, string> ClassicFluKeys = new(StringComparer.Ordinal)
    {
        ["flucelvax"] = "f",
        ["mflusiva"] = "l",
        ["fluad"] = "d",
    };

    public const string AdultPfizer = "pfizer";
    public const string AdultModerna = "moderna";

    /// <summary>Classic letters that mean nothing in the new profile (mFLUSIVA's old L is released).</summary>
    public IReadOnlyList<string> Blocked { get; }

    /// <summary>New key -> what it does. Keys not listed pass through to the page unchanged.</summary>
    public IReadOnlyDictionary<string, HotkeyAction> Keys { get; }

    /// <summary>Labels whose hotkey underline is wrong in the classic page and is replaced by a badge.</summary>
    public IReadOnlyList<HotkeyRelabel> Relabel { get; }

    /// <summary>
    /// The classic letters this plan rewrites TO (cloud lib/macro-hotkeys.ts
    /// MACRO_HOTKEYS). Before rewriting, the page script checks the page still
    /// underlines exactly these letters in these labels; if a label shows a
    /// different letter (the website changed), rewriting is switched off for
    /// that page load so a key can never enter the wrong product.
    /// </summary>
    public static IReadOnlyList<ClassicLabel> ClassicLabels { get; } = new[]
    {
        new ClassicLabel("flucelvax", "f"),
        new ClassicLabel("mflusiva", "l"),
        new ClassicLabel("fluad", "d"),
        new ClassicLabel("capvaxive", "c"),
        new ClassicLabel("vaqta", "v"),
    };

    private Flu2HotkeyPlan(
        IReadOnlyList<string> blocked,
        IReadOnlyDictionary<string, HotkeyAction> keys,
        IReadOnlyList<HotkeyRelabel> relabel)
    {
        Blocked = blocked;
        Keys = keys;
        Relabel = relabel;
    }

    /// <param name="ageYears">The patient's age when the picker was opened with one (Ctrl+Keypad 2/7); null for the plain Ctrl+Keypad 8 popup.</param>
    /// <param name="preferredCovidAdult">AppSettings.PreferredCovidAdult: "pfizer" (Comirnaty) or "moderna"; anything else means pfizer.</param>
    public static Flu2HotkeyPlan For(int? ageYears, string? preferredCovidAdult)
    {
        var keys = new Dictionary<string, HotkeyAction>(StringComparer.Ordinal)
        {
            ["x"] = new HotkeyAction("f", null),   // Flucelvax
            ["v"] = new HotkeyAction("l", null),   // mFLUSIVA
            ["a"] = new HotkeyAction("c", null),   // Capvaxive (was C)
            ["q"] = new HotkeyAction("v", null),   // Vaqta (was V)
            ["f"] = SmartFlu(ageYears),
            ["c"] = SmartCovid(ageYears, preferredCovidAdult),
        };
        // D stays Fluad; U FluMist; P/M/3/R/S/N/B/G/E/O/T/I are unchanged.

        var relabel = new List<HotkeyRelabel>
        {
            new("flucelvax", "X"),
            new("mflusiva", "V"),
            new("capvaxive", "A"),
            new("vaqta", "Q"),
        };

        return new Flu2HotkeyPlan(new[] { "l" }, keys, relabel);
    }

    /// <summary>F: the preferred flu for the age (3-49 Flucelvax, 50-64 mFLUSIVA, 65+ Fluad), as that product's classic key.</summary>
    public static HotkeyAction SmartFlu(int? ageYears)
    {
        if (ageYears is not int age)
        {
            return new HotkeyAction(null, "F needs the patient's age - use Ctrl+Keypad 2.");
        }

        var product = FluPreferenceRules.PreferredFor(age);
        if (product is null)
        {
            return new HotkeyAction(null, "No flu vaccine under age 3.");
        }

        return ClassicFluKeys.TryGetValue(product.CodePrefix, out var classic)
            ? new HotkeyAction(classic, null)
            : new HotkeyAction(null, $"{product.DisplayName} has no hotkey.");
    }

    /// <summary>C: the preferred COVID vaccine for the age under the location setting (12+ -> adult setting, 3-11 -> Moderna kids), as that product's classic key.</summary>
    public static HotkeyAction SmartCovid(int? ageYears, string? preferredCovidAdult)
    {
        if (ageYears is not int age)
        {
            return new HotkeyAction(null, "C needs the patient's age - use Ctrl+Keypad 2.");
        }

        var choice = PreferredCovidFor(age, preferredCovidAdult);
        return choice is null
            ? new HotkeyAction(null, "No COVID vaccine under age 3.")
            : new HotkeyAction(choice.ClassicKey, null);
    }

    /// <summary>Same rule as the cloud's lib/preferred-covid.ts preferredCovidForAge. Null under age 3.</summary>
    public static PreferredCovidChoice? PreferredCovidFor(int ageYears, string? preferredCovidAdult)
    {
        if (ageYears < 3) return null;
        if (ageYears >= 12)
        {
            return string.Equals((preferredCovidAdult ?? "").Trim(), AdultModerna, StringComparison.OrdinalIgnoreCase)
                ? new PreferredCovidChoice("m", "Moderna 12+")
                : new PreferredCovidChoice("p", "Pfizer 12+ (Comirnaty)");
        }

        return new PreferredCovidChoice("3", "Moderna 3-11");
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public string ToJson() => JsonSerializer.Serialize(new { blocked = Blocked, keys = Keys, relabel = Relabel, classic = ClassicLabels }, JsonOptions);
}
