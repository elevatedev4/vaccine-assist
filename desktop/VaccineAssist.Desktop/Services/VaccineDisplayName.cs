using System.Text.RegularExpressions;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// Mirrors cloud/lib/vaccine-display-name.ts's vaccineDisplayName exactly
/// (Will, V-T55, 2026-09-25 verbatim: "It should show the same names
/// everywhere that it is applicable.") — adds a manufacturer prefix to
/// COVID vaccine names for DISPLAY ONLY. The desktop app calls
/// GET /api/vaccines and GET /api/physician-rules directly (see
/// Services/VaccineApiService.cs) and gets back the raw stored name; the
/// cloud side's own displayName addition to those JSON payloads is a
/// separate, parallel change this does NOT depend on, so the rule is
/// re-implemented here rather than read off the wire.
///
/// Case-insensitive on the match; any season/age suffix already on the
/// name (e.g. "Comirnaty 2026-27 12+") is preserved verbatim after the
/// prefix. Idempotent: a name that already starts with "Pfizer"/"Moderna"
/// (any case) is returned unchanged rather than double-prefixed. Every
/// non-COVID name passes through untouched. Null/empty-safe: never throws,
/// returns "" for a null/empty input.
///
/// Callers MUST apply this ONLY where a vaccine name is rendered to a
/// human — never to a value used for matching, sorting keys, API request
/// payloads, PioneerRx automation input, or anything persisted/looked up
/// by name. See VaccineAssist.Desktop.Common.VaccineDisplayNameConverter
/// for the XAML-binding equivalent of this same rule.
/// </summary>
public static class VaccineDisplayName
{
    private static readonly Regex AlreadyPrefixed =
        new(@"^(pfizer|moderna)\b\s*", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly (Regex Test, string Prefix)[] CovidPrefixes =
    {
        (new Regex(@"^comirnaty", RegexOptions.IgnoreCase | RegexOptions.Compiled), "Pfizer"),
        (new Regex(@"^spikevax", RegexOptions.IgnoreCase | RegexOptions.Compiled), "Moderna"),
        (new Regex(@"^mnexspike", RegexOptions.IgnoreCase | RegexOptions.Compiled), "Moderna"),
    };

    /// <summary>Returns <paramref name="name"/> with "Pfizer "/"Moderna "
    /// prefixed when it names a COVID product (Comirnaty/Spikevax/
    /// mNEXSPIKE), unchanged otherwise. Never null.</summary>
    public static string For(string? name)
    {
        if (string.IsNullOrEmpty(name)) return name ?? "";
        if (AlreadyPrefixed.IsMatch(name)) return name;

        foreach (var (test, prefix) in CovidPrefixes)
        {
            if (test.IsMatch(name)) return $"{prefix} {name}";
        }

        return name;
    }
}
