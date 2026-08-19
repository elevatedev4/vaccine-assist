using System.Text.Json.Serialization;

namespace VaccineAssist.Desktop.Models;

/// <summary>
/// Mirrors the JSON body of GET /api/acuity/poll (see
/// cloud/app/api/acuity/poll/route.ts's RESPONSE CONTRACT doc comment).
/// Only the fields the Scheduling tab actually needs are modeled —
/// `range`/`counts`/`possiblyTruncated`/`cacheHit` from that contract are
/// intentionally left off since nothing here reads them yet.
/// </summary>
public sealed class AppointmentScheduleResult
{
    [JsonPropertyName("configured")]
    public bool Configured { get; set; }

    /// <summary>Present (and Table null) when Acuity credentials aren't
    /// configured yet on the cloud side — shown as-is in the Scheduling
    /// tab's status area instead of an error.</summary>
    [JsonPropertyName("message")]
    public string? Message { get; set; }

    /// <summary>Null when Configured is false, or if an older cloud
    /// deployment hasn't shipped the `table` field yet.</summary>
    [JsonPropertyName("table")]
    public AppointmentTable? Table { get; set; }

    [JsonPropertyName("asOf")]
    public string? AsOf { get; set; }
}
