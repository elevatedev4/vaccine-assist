namespace VaccineAssist.Desktop.Uia;

/// <summary>
/// Window-title-prefix and process-name constants for detecting PioneerRx,
/// mirrored from rx-verify's confirmed values
/// (overlay/RxVerifyOverlay/Uia/FieldMap.cs — TargetWindowTitlePrefixes /
/// TargetProcessNames), since both apps automate the same PioneerRx
/// install.
///
/// CONFIRMED (2026-09-05, live UIA tree dumps of the vaccine-entry
/// screens — see PioneerEntryAutomation/TODO.md): the vaccine-entry
/// precondition is "the patient's Rx Profile is open" (window title
/// "Rx Profile - &lt;patient&gt; - ...") through "an Add New Rx is in
/// progress" (window title "Add New Rx" while a modal sub-dialog like the
/// priority/promise-time prompt is up, then "Add New Rx - &lt;patient&gt; -
/// ..." once the patient context resolves). "Rx Profile" is a NEW prefix
/// added by that confirmation; "New Rx" already matched "Add New Rx" via
/// the Contains widening below (rx-verify's own three prefixes were
/// confirmed against its different screens: Pre-Check Rx / Edit Rx / New
/// Rx). Kept widened (Contains + process-name fallback) rather than
/// narrowed to only these two, since PioneerEntryAutomation's steps may
/// also need to run against other screens later.
/// </summary>
public static class PioneerRxTitles
{
    public static readonly string[] TargetWindowTitlePrefixes =
    {
        "Pre-Check Rx",
        "Edit Rx",
        "New Rx",
        "Rx Profile",
    };

    /// <summary>Confirmed via Task Manager in rx-verify (2026-08-11): the real executable is PioneerPharmacy.exe, with PioneerRx kept as a fallback name.</summary>
    public static readonly string[] TargetProcessNames = { "PioneerPharmacy", "PioneerRx" };
}
