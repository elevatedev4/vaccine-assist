using System;
using System.Text.Json.Serialization;

namespace VaccineAssist.Desktop.Models;

/// <summary>
/// Mirrors the `appointment_count` table. Not surfaced in any phase-1
/// screen (the reporting UI is skipped for now — see README) but kept
/// here so the model layer already matches the full schema.
/// </summary>
public sealed class AppointmentCount
{
    [JsonPropertyName("id")]
    public Guid Id { get; set; }

    [JsonPropertyName("date")]
    public DateOnly Date { get; set; }

    [JsonPropertyName("vaccine_type")]
    public string VaccineType { get; set; } = "";

    [JsonPropertyName("count")]
    public int Count { get; set; }
}
