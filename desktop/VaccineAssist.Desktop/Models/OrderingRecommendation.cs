using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace VaccineAssist.Desktop.Models;

/// <summary>
/// Mirrors the JSON body of GET /api/ordering/recommendation (see
/// cloud/app/api/ordering/recommendation/route.ts's RESPONSE CONTRACT doc
/// comment):
///   {
///     "onHandLastReceivedAt": "2026-08-19T13:00:00.000Z" | null,
///     "rows": [
///       { "vaccineId": "uuid", "vaccineName": "...", "upcoming7d": 12,
///         "onHand": 8, "onHandAsOf": "..." | null, "recommendedOrder": 5 }
///     ]
///   }
/// </summary>
public sealed class OrderingRecommendationResult
{
    [JsonPropertyName("onHandLastReceivedAt")]
    public DateTimeOffset? OnHandLastReceivedAt { get; set; }

    [JsonPropertyName("rows")]
    public List<OrderingRecommendationRow> Rows { get; set; } = new();
}

public sealed class OrderingRecommendationRow
{
    [JsonPropertyName("vaccineId")]
    public Guid VaccineId { get; set; }

    [JsonPropertyName("vaccineName")]
    public string VaccineName { get; set; } = "";

    [JsonPropertyName("upcoming7d")]
    public int Upcoming7d { get; set; }

    /// <summary>Null when no matched on-hand count has been received yet
    /// for this vaccine.</summary>
    [JsonPropertyName("onHand")]
    public int? OnHand { get; set; }

    [JsonPropertyName("onHandAsOf")]
    public DateTimeOffset? OnHandAsOf { get; set; }

    [JsonPropertyName("recommendedOrder")]
    public int RecommendedOrder { get; set; }

    /// <summary>Display string for the "On hand (as of date)" column —
    /// e.g. "8 (as of Aug 19)" or "no data yet" when OnHand is null.</summary>
    public string OnHandDisplay => OnHand is int qty
        ? OnHandAsOf is DateTimeOffset asOf
            ? $"{qty} (as of {asOf.LocalDateTime:MMM d})"
            : qty.ToString()
        : "no data yet";
}
