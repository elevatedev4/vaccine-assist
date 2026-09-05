using System.Collections.Generic;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;

/// <summary>
/// The ONE sequence implementation shipped for vaccine entry (V-T3 item
/// 3). WIRED FOR REAL as of 2026-09-05 against live PioneerRx UIA tree
/// dumps of the "Add New Rx" screen — every step below except
/// ConfirmEntryStep now performs a real FlaUI action instead of returning
/// PENDING-MACRO-FILE; see each step's own doc comment for its confirmed
/// field target and dump evidence. ConfirmEntryStep deliberately still
/// stops short of clicking PioneerRx's own Save button — see that step's
/// doc comment for why (safety: writes to a real pharmacy system).
///
/// CLASS NAME KEPT (not renamed to something like "AddNewRxVaccineEntrySequence"
/// now that it's real, and its own Name property below no longer says
/// "PENDING-MACRO-FILE placeholder") — a rename would ripple through
/// App.xaml.cs's composition root and multiple test files with zero
/// behavior change, which felt like unnecessary churn for a cosmetic
/// improvement; flagged as a judgment call, not an oversight.
///
/// STEP ORDER (Will's own described workflow, physician-then-drug, plus
/// the live dumps' own progressive-fill order — prescriber and drug/
/// quantity/days-supply all appeared together in the SAME dump capture,
/// lot/expiration only in the LAST one):
///   1. FocusPioneerWindowStep — attach to the PioneerRx window (real
///      since before this change).
///   2. SelectPrescriberStep — physician alternate ID, ENTER x2 (was
///      "NavigateToVaccineFieldsStep": the real Add New Rx screen needs
///      no separate navigation step, every field is already visible).
///   3. InputVaccineCodeStep — drug NDC, ENTER x2.
///   4. InputLotAndExpirationStep — lot + expiration, plain text entry.
///   5. ConfirmEntryStep — locates PioneerRx's Save &amp; Continue button
///      but does not click it (safety stop before the real Rx save).
/// </summary>
public sealed class PlaceholderVaccineEntrySequence : IPioneerEntrySequence
{
    public string Name => "Vaccine entry (Add New Rx)";

    public IReadOnlyList<IPioneerEntryStep> Steps { get; } = new IPioneerEntryStep[]
    {
        new FocusPioneerWindowStep(),
        new SelectPrescriberStep(),
        new InputVaccineCodeStep(),
        new InputLotAndExpirationStep(),
        new ConfirmEntryStep(),
    };
}
