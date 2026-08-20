using System;
using System.Text.Json.Serialization;

namespace VaccineAssist.Desktop.Models;

/// <summary>
/// Mirrors the `vaccine` table (supabase/migrations/0001_init.sql).
/// Property names use [JsonPropertyName] because PostgREST (via the
/// cloud app's /api/vaccines route) returns raw Postgres column names —
/// snake_case, not camelCase.
/// </summary>
public sealed class Vaccine
{
    [JsonPropertyName("id")]
    public Guid Id { get; set; }

    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("ndc")]
    public string? Ndc { get; set; }

    [JsonPropertyName("dose")]
    public string? Dose { get; set; }

    [JsonPropertyName("short_code")]
    public string ShortCode { get; set; } = "";

    [JsonPropertyName("cash_price_cents")]
    public int? CashPriceCents { get; set; }

    [JsonPropertyName("active")]
    public bool Active { get; set; }

    /// <summary>Only populated by GET /api/vaccines?includeInactive=true
    /// (the desktop Active vaccines tab's admin call) — true when `lot`
    /// has at least one row for this vaccine with status='active'. The
    /// default (no-query-param) GET used by Lots/Data-entry doesn't
    /// compute this and the JSON simply omits the field, so it stays
    /// false there — harmless, since neither of those screens reads it.</summary>
    [JsonPropertyName("hasActiveLot")]
    public bool HasActiveLot { get; set; }

    /// <summary>Formatted for display, e.g. "$147.99" or "—" when unknown.</summary>
    public string CashPriceDisplay => CashPriceCents is int cents ? (cents / 100.0).ToString("C") : "—";

    public override string ToString() => $"{Name} ({ShortCode})";
}
