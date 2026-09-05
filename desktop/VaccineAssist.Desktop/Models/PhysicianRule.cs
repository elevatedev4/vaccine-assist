using System;
using System.Text.Json.Serialization;

namespace VaccineAssist.Desktop.Models;

/// <summary>
/// Mirrors the `physician_rule` table (supabase/migrations/0007_physicians.sql)
/// — which physician covers a given vaccine + age range. VaccineId null
/// means "any vaccine" (the wildcard/"everything else" fallback rule);
/// see cloud/lib/physician-resolution.ts resolvePhysicianRule for the
/// exact specificity-then-priority tie-break the cloud side runs.
/// </summary>
public sealed class PhysicianRule
{
    [JsonPropertyName("id")]
    public Guid Id { get; set; }

    [JsonPropertyName("physician_id")]
    public Guid PhysicianId { get; set; }

    [JsonPropertyName("vaccine_id")]
    public Guid? VaccineId { get; set; }

    [JsonPropertyName("min_age")]
    public int? MinAge { get; set; }

    [JsonPropertyName("max_age")]
    public int? MaxAge { get; set; }

    [JsonPropertyName("priority")]
    public int Priority { get; set; }
}
