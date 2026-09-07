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

    /// <summary>Only populated by GET /api/eligibility/for-age?age=N (the
    /// data-entry popup's guided-flow age step — see
    /// DataEntryPopupViewModel.ContinueFromAgeAsync) — that vaccine's own
    /// eligibility result for the age that was queried. Null everywhere
    /// else (GetVaccinesAsync, GetAllVaccinesAsync), same "populated only
    /// by the one endpoint that computes it" convention as HasActiveLot
    /// above.</summary>
    [JsonPropertyName("eligibility")]
    public EligibilityResult? Eligibility { get; set; }

    /// <summary>
    /// This vaccine's administered quantity, for PioneerRx's "Add New Rx"
    /// quantity field (Will, 2026-09-07: "did not yet enter the quantity...
    /// Each vaccine will have its own quantity"). Populated by the
    /// `vaccines.quantity` column — confirmed on main as `text`, NOT
    /// numeric (supabase/migrations/0009_lots_bud_vaccine_defaults.sql
    /// lines 26-30: free-text because Pioneer's own quantity field accepts
    /// arbitrary strings like "0.5 mL" or "1 dose IM x1", not a single unit
    /// type) — REVIEWER FIX 2026-09-07: this was originally typed
    /// `decimal?`, which would have hard-crashed GetVaccinesAsync (and
    /// every screen that loads vaccines) the moment a real, non-numeric
    /// quantity string was ever entered on the cloud /vaccines page, since
    /// PostgREST serializes a `text` column as a JSON string and this
    /// service deserializes with strict default System.Text.Json options.
    /// Null until that migration runs, or when a specific vaccine simply
    /// has no quantity set yet. Sequencing/Steps/InputQuantityStep.cs SKIPS
    /// typing anything into Pioneer when this is null/blank rather than
    /// guessing or typing a placeholder value, and types whatever string IS
    /// here VERBATIM (no numeric parsing/formatting).
    /// </summary>
    [JsonPropertyName("quantity")]
    public string? Quantity { get; set; }

    /// <summary>
    /// Free-text directions/sig for PioneerRx's "Add New Rx" directions
    /// field. Same null-tolerant/skip posture as Quantity above — see
    /// Sequencing/Steps/InputDirectionsStep.cs.
    /// </summary>
    [JsonPropertyName("directions")]
    public string? Directions { get; set; }

    /// <summary>Formatted for display, e.g. "$147.99" or "—" when unknown.</summary>
    public string CashPriceDisplay => CashPriceCents is int cents ? (cents / 100.0).ToString("C") : "—";

    public override string ToString() => $"{Name} ({ShortCode})";
}
