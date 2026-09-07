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
/// 2026-09-07 UPDATE (Will, verbatim): "The data entry should start from
/// the patient Rx Profile, not from Add New Rx. So from that profile
/// screen, push F3, then two windows will open that have to be escaped
/// from, Priority, and Scan hard copy... Once on Add New Rx, you
/// successfully got to enter the prescriber and vaccine by NDC, but did
/// not yet enter the quantity, directions, lot, or expiration." Added
/// SendF3AndDismissPreEntryDialogsStep (the Rx-Profile-to-Add-New-Rx
/// transition) right after FocusPioneerWindowStep, and InputQuantityStep +
/// InputDirectionsStep right after InputVaccineCodeStep, matching that
/// entry order exactly.
///
/// STEP ORDER (Will's own described workflow, physician-then-drug, plus
/// the live dumps' own progressive-fill order — prescriber and drug/
/// quantity/days-supply all appeared together in the SAME dump capture,
/// lot/expiration only in the LAST one):
///   1. FocusPioneerWindowStep — attach to the PioneerRx window (real
///      since before this change) — the patient's Rx Profile.
///   2. SendF3AndDismissPreEntryDialogsStep — F3 from the Rx Profile,
///      ESC through the "Priority"/"Scan Hard Copy" dialogs if they
///      appear, re-attach to the resulting "Add New Rx" window (NEW,
///      2026-09-07 — see its own doc comment; NOT confirmed against a
///      live UIA dump, unlike every step below it).
///   3. SelectPrescriberStep — physician alternate ID, ENTER x2 (was
///      "NavigateToVaccineFieldsStep": the real Add New Rx screen needs
///      no separate navigation step, every field is already visible).
///   4. InputVaccineCodeStep — drug NDC, ENTER x2.
///   5. InputQuantityStep — this vaccine's quantity (NEW, 2026-09-07 —
///      reverses InputVaccineCodeStep's earlier "don't type into
///      uxQuantityPrescribed, it auto-populates" decision; see that
///      step's own doc comment).
///   6. InputDirectionsStep — this vaccine's directions (NEW, 2026-09-07
///      — placeholder AutomationId, not yet confirmed against a live UIA
///      dump; see that step's own doc comment).
///   7. InputLotAndExpirationStep — lot + expiration, plain text entry.
///   8. ConfirmEntryStep — locates PioneerRx's Save &amp; Continue button
///      but does not click it (safety stop before the real Rx save).
/// </summary>
public sealed class PlaceholderVaccineEntrySequence : IPioneerEntrySequence
{
    public string Name => "Vaccine entry (Add New Rx)";

    public IReadOnlyList<IPioneerEntryStep> Steps { get; } = new IPioneerEntryStep[]
    {
        new FocusPioneerWindowStep(),
        new SendF3AndDismissPreEntryDialogsStep(),
        new SelectPrescriberStep(),
        new InputVaccineCodeStep(),
        new InputQuantityStep(),
        new InputDirectionsStep(),
        new InputLotAndExpirationStep(),
        new ConfirmEntryStep(),
    };
}
