using System;
using System.Text.Json.Serialization;

namespace VaccineAssist.Desktop.Models;

/// <summary>
/// Mirrors the `physician` table (supabase/migrations/0007_physicians.sql)
/// — a protocol physician staff can assign vaccine/age-range rules to
/// (see PhysicianRule). AlternateId is the ID set on this physician's own
/// Pioneer profile (Prescriber profile > Alternate ID) — PioneerRx's own
/// physician quick-search resolves a prescriber from it, per Will's
/// described workflow (type the alternate ID, press Enter twice).
/// </summary>
public sealed class Physician
{
    [JsonPropertyName("id")]
    public Guid Id { get; set; }

    [JsonPropertyName("display_name")]
    public string DisplayName { get; set; } = "";

    [JsonPropertyName("alternate_id")]
    public string AlternateId { get; set; } = "";

    public override string ToString() => $"{DisplayName} ({AlternateId})";
}
