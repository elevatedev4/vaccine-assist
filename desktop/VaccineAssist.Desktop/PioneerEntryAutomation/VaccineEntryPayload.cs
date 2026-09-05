namespace VaccineAssist.Desktop.PioneerEntryAutomation;

/// <summary>
/// Everything needed to type one vaccine administration record into
/// PioneerRx's real "Add New Rx" screen (confirmed against live UIA tree
/// dumps, 2026-09-05 — see PioneerEntryAutomation/TODO.md and
/// Sequencing/Steps/*.cs's own doc comments for exactly which control
/// each field types into): physician alternate ID into the prescriber
/// quick-search, drug NDC into the item quick-search (each followed by
/// two ENTERs per Will's own described workflow), then lot + expiration
/// into the dispensed-drug panel.
/// </summary>
/// <param name="ShortCode">The macro/product short code, e.g. "mmr1" (see supabase/seed/vaccines.sql).
/// No longer used by the real (non-placeholder) steps — kept only for
/// ToClipboardPayload's macro-era fallback format.</param>
/// <param name="LotNumber">As entered on the Lots screen.</param>
/// <param name="ExpirationMacroFormat">MMDDYYYY, matching the macro's own format exactly (Models.Lot.ExpirationMacroFormat).
/// InputLotAndExpirationStep reformats this to PioneerRx's own date-edit
/// format (M/d/yyyy, confirmed against the live dump's uxLotExpirationDate
/// value) before typing it — see that step's doc comment.</param>
/// <param name="AdminSiteDisplayText">"Left arm" or "Right arm" (Models.AdminSiteExtensions.ToDisplayText).
/// Not wired against any live control yet — no administration-site field
/// was confirmed in the Add New Rx dumps (see ConfirmEntryStep's doc).</param>
/// <param name="Ndc">The vaccine's NDC (Models.Vaccine.Ndc) — typed into PioneerRx's drug
/// quick-search field by InputVaccineCodeStep, then ENTER twice per
/// Will's described workflow. Empty when the vaccine catalog has no NDC
/// on file; InputVaccineCodeStep surfaces that as a named failure rather
/// than typing nothing.</param>
/// <param name="PhysicianAlternateId">
/// The Pioneer "alternate ID" of the protocol physician resolved for this
/// vaccine + patient age (see DataEntryPopupViewModel.BuildPayloadAsync,
/// IVaccineApiService.ResolvePhysicianAsync, and the Physicians settings
/// tab where alternate IDs are configured) — typed into PioneerRx's
/// prescriber quick-search field by SelectPrescriberStep, then ENTER
/// twice. Empty only when no VaccineEntryPayload has been safely resolved
/// yet; BuildPayloadAsync blocks entry entirely (never builds a payload)
/// when no physician rule matches, so a real payload should never carry
/// an empty value here.</param>
/// <param name="IsMedicareHomeVisit">Mirrors the macro's "medicarehomevisit" special case — skips the
/// normal product-code entry and instead prompts for a home-visit reason (see TODO.md).</param>
/// <param name="HomeVisitReason">Only set when IsMedicareHomeVisit is true.</param>
/// <param name="SkipLotAndExpiration">
/// True when staff explicitly chose "Leave lot/expiration blank and
/// proceed" on the data-entry popup's expiration gate (no unexpired lot
/// was on file for the selected vaccine — see
/// DataEntryPopupViewModel.IsLotExpiredOrMissing/SkipLotAndExpirationCommand).
/// LotNumber/ExpirationMacroFormat are meaningless ("") when this is true;
/// InputLotAndExpirationStep checks this FIRST and skips its own PioneerRx
/// work entirely rather than trying to type blank values into the admin
/// form.
/// </param>
public sealed record VaccineEntryPayload(
    string ShortCode,
    string LotNumber,
    string ExpirationMacroFormat,
    string AdminSiteDisplayText,
    string Ndc = "",
    string PhysicianAlternateId = "",
    bool IsMedicareHomeVisit = false,
    string? HomeVisitReason = null,
    bool SkipLotAndExpiration = false)
{
    /// <summary>The exact "code,lot,exp" clipboard format the old macro read from
    /// %vaccinedata% (vaccine-add-new.mxe line 32-36) — kept for the Entry
    /// screen's "copy to clipboard" fallback even once live automation exists.</summary>
    public string ToClipboardPayload() => $"{ShortCode},{LotNumber},{ExpirationMacroFormat}";
}
