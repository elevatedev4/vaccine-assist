using System;
using System.Text.Json.Serialization;

namespace VaccineAssist.Desktop.Models;

/// <summary>Mirrors the `lot` table (supabase/migrations/0001_init.sql).</summary>
public sealed class Lot
{
    [JsonPropertyName("id")]
    public Guid Id { get; set; }

    [JsonPropertyName("vaccine_id")]
    public Guid VaccineId { get; set; }

    [JsonPropertyName("lot_number")]
    public string LotNumber { get; set; } = "";

    [JsonPropertyName("expiration")]
    public DateOnly Expiration { get; set; }

    /// <summary>"active" or "depleted" — kept as the raw DB string (a
    /// Postgres enum) rather than a C# enum, to avoid a JSON naming-policy
    /// mismatch between the two for two possible values.</summary>
    [JsonPropertyName("status")]
    public string Status { get; set; } = "active";

    [JsonPropertyName("note")]
    public string? Note { get; set; }

    public bool IsActive => string.Equals(Status, "active", StringComparison.OrdinalIgnoreCase);

    public bool IsExpired => Expiration < DateOnly.FromDateTime(DateTime.Today);

    /// <summary>MMDDYYYY, matching the old macro's clipboard payload format exactly.</summary>
    public string ExpirationMacroFormat => Expiration.ToString("MMddyyyy");
}
