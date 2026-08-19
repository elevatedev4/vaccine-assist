namespace VaccineAssist.Desktop.Uia;

/// <summary>
/// Window-title-prefix and process-name constants for detecting PioneerRx,
/// mirrored from rx-verify's confirmed values
/// (overlay/RxVerifyOverlay/Uia/FieldMap.cs — TargetWindowTitlePrefixes /
/// TargetProcessNames), since both apps automate the same PioneerRx
/// install.
///
/// CAVEAT: rx-verify confirmed these window titles against its OWN
/// screens (Pre-Check Rx / Edit Rx / New Rx — the Rx Profile / e-script
/// views). Nobody has yet confirmed what window is open specifically for
/// vaccine data entry (V-T3's brief: "pull up the patient's rx profile,
/// then activate data entry mode" — so one of these same three screens is
/// the LIKELY target, but not yet verified against a live UIA dump). Kept
/// as the best available signal for now; PioneerRxAttachment logs which
/// title it actually matched so this list can be corrected once wired up
/// live, without needing a rebuild (see PioneerEntryAutomation/TODO.md).
/// </summary>
public static class PioneerRxTitles
{
    public static readonly string[] TargetWindowTitlePrefixes =
    {
        "Pre-Check Rx",
        "Edit Rx",
        "New Rx",
    };

    /// <summary>Confirmed via Task Manager in rx-verify (2026-08-11): the real executable is PioneerPharmacy.exe, with PioneerRx kept as a fallback name.</summary>
    public static readonly string[] TargetProcessNames = { "PioneerPharmacy", "PioneerRx" };
}
