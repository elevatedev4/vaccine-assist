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

    /// <summary>
    /// Populated by the `physician_rule.vaccine_group` column — added by a
    /// parallel migration effort alongside this change (see
    /// PioneerEntryAutomation/TODO.md's 2026-09-07 entry). Only meaningful
    /// when VaccineId is null: this rule applies to every vaccine in this
    /// VaccineGroupCatalog group (Will, 2026-09-07: "assign vaccine TYPES,
    /// not just specific vaccines, to a protocol physician"). Null on both
    /// a specific-vaccine rule (VaccineId set — VaccineGroup is ignored)
    /// and a true wildcard/"any vaccine" fallback rule (both null). See
    /// PhysicianRuleMatcher for the specific &gt; group &gt; wildcard
    /// precedence this enables.
    /// </summary>
    [JsonPropertyName("vaccine_group")]
    public string? VaccineGroup { get; set; }

    [JsonPropertyName("min_age")]
    public int? MinAge { get; set; }

    [JsonPropertyName("max_age")]
    public int? MaxAge { get; set; }

    [JsonPropertyName("priority")]
    public int Priority { get; set; }
}
