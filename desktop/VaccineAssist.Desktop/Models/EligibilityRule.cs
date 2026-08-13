using System;
using System.Text.Json.Serialization;

namespace VaccineAssist.Desktop.Models;

/// <summary>Mirrors the `eligibility_rule` table (supabase/migrations/0001_init.sql).</summary>
public sealed class EligibilityRule
{
    [JsonPropertyName("id")]
    public Guid Id { get; set; }

    [JsonPropertyName("vaccine_id")]
    public Guid VaccineId { get; set; }

    [JsonPropertyName("min_age")]
    public int? MinAge { get; set; }

    [JsonPropertyName("max_age")]
    public int? MaxAge { get; set; }

    [JsonPropertyName("condition_note")]
    public string? ConditionNote { get; set; }

    [JsonPropertyName("pregnancy_warning")]
    public bool PregnancyWarning { get; set; }

    [JsonPropertyName("priority")]
    public int Priority { get; set; }
}
