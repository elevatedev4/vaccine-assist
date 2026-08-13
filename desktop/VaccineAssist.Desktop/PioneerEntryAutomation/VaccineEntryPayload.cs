namespace VaccineAssist.Desktop.PioneerEntryAutomation;

/// <summary>
/// Everything needed to type one vaccine administration record into
/// PioneerRx — the same fields vaccine-add-new.mxe's final steps
/// (lines 298-337) typed via keystrokes: vaccine code into the product
/// search, then lot + expiration into the admin form, then "w" to
/// confirm and tab through.
/// </summary>
/// <param name="ShortCode">The macro/product short code, e.g. "mmr1" (see supabase/seed/vaccines.sql).</param>
/// <param name="LotNumber">As entered on the Lots screen.</param>
/// <param name="ExpirationMacroFormat">MMDDYYYY, matching the macro's own format exactly (Models.Lot.ExpirationMacroFormat).</param>
/// <param name="AdminSiteDisplayText">"Left arm" or "Right arm" (Models.AdminSiteExtensions.ToDisplayText).</param>
/// <param name="IsMedicareHomeVisit">Mirrors the macro's "medicarehomevisit" special case — skips the
/// normal product-code entry and instead prompts for a home-visit reason (see TODO.md).</param>
/// <param name="HomeVisitReason">Only set when IsMedicareHomeVisit is true.</param>
public sealed record VaccineEntryPayload(
    string ShortCode,
    string LotNumber,
    string ExpirationMacroFormat,
    string AdminSiteDisplayText,
    bool IsMedicareHomeVisit = false,
    string? HomeVisitReason = null)
{
    /// <summary>The exact "code,lot,exp" clipboard format the old macro read from
    /// %vaccinedata% (vaccine-add-new.mxe line 32-36) — kept for the Entry
    /// screen's "copy to clipboard" fallback even once live automation exists.</summary>
    public string ToClipboardPayload() => $"{ShortCode},{LotNumber},{ExpirationMacroFormat}";
}
