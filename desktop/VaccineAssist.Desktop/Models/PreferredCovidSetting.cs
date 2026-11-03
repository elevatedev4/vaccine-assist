using System;

namespace VaccineAssist.Desktop.Models;

/// <summary>
/// The cloud's pharmacy-wide preferred COVID vaccine
/// (GET/PUT /api/settings/preferred-covid, key macro.preferred_covid):
/// Adult is "pfizer" or "moderna" (ages 12+); Kids is always "moderna"
/// (ages 3-11 - the only product stocked, same as the cloud's own list).
/// </summary>
public sealed record PreferredCovidSetting(string Adult, string Kids)
{
    public const string AdultPfizer = "pfizer";
    public const string AdultModerna = "moderna";
    public const string KidsModerna = "moderna";

    /// <summary>Case/whitespace-tolerant map of a cloud or local value to "pfizer" / "moderna"; null for anything else.</summary>
    public static string? NormalizeAdult(string? value)
    {
        var trimmed = (value ?? "").Trim();
        if (string.Equals(trimmed, AdultPfizer, StringComparison.OrdinalIgnoreCase)) return AdultPfizer;
        if (string.Equals(trimmed, AdultModerna, StringComparison.OrdinalIgnoreCase)) return AdultModerna;
        return null;
    }
}
