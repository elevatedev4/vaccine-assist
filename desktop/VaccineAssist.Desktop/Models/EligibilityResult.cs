using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace VaccineAssist.Desktop.Models;

/// <summary>
/// Response shape from POST /api/eligibility/evaluate — mirrors
/// cloud/lib/eligibility.ts's EligibilityResult exactly (already
/// single-word camelCase property names, no snake_case mismatch here).
/// </summary>
public sealed class EligibilityResult
{
    [JsonPropertyName("status")]
    public string Status { get; set; } = "warning";

    [JsonPropertyName("reasons")]
    public List<string> Reasons { get; set; } = new();

    [JsonPropertyName("warnings")]
    public List<string> Warnings { get; set; } = new();

    public bool IsBlocked => Status == "blocked";
}
