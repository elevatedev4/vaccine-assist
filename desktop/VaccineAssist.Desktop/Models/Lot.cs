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

    /// <summary>
    /// Populated by the `lots.beyond_use_date` column — added by a parallel
    /// migration effort alongside this change (vaccines.quantity/directions,
    /// physician_rule.vaccine_group; see PioneerEntryAutomation/TODO.md's
    /// 2026-09-07 entry). Null until that migration runs, or when a lot
    /// simply has no BUD recorded yet — IsPastBeyondUseDate treats null the
    /// same as "no BUD constraint," never a guessed block.
    /// </summary>
    [JsonPropertyName("beyond_use_date")]
    public DateOnly? BeyondUseDate { get; set; }

    public bool IsActive => string.Equals(Status, "active", StringComparison.OrdinalIgnoreCase);

    public bool IsExpired => Expiration < DateOnly.FromDateTime(DateTime.Today);

    /// <summary>
    /// True when BeyondUseDate is set and is today or earlier. Will's brief
    /// (2026-09-07): entry must HALT "when the chosen vaccine's lot is
    /// expired OR past its beyond-use date" — see
    /// DataEntryPopupViewModel.IsLotExpiredOrMissing, which now checks this
    /// alongside IsExpired.
    /// </summary>
    public bool IsPastBeyondUseDate => BeyondUseDate is DateOnly bud && bud <= DateOnly.FromDateTime(DateTime.Today);

    /// <summary>MMDDYYYY, matching the old macro's clipboard payload format exactly.</summary>
    public string ExpirationMacroFormat => Expiration.ToString("MMddyyyy");
}
