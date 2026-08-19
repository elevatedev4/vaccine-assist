using System.Collections.Generic;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;

/// <summary>
/// The ONE sequence implementation shipped in phase 1 (V-T3 item 3:
/// "Implement ONE placeholder sequence marked clearly as
/// PENDING-MACRO-FILE"). Structure, ordering, per-step logging, dry-run
/// handling, and error handling are all real and match
/// vaccine-add-new.mxe's own final keystroke sequence shape (lines
/// 298-337, per PioneerEntryAutomation/TODO.md) — only the two middle
/// steps' actual field targets are stubbed, since there's no live
/// PioneerRx UIA tree dump to confirm AutomationIds against yet.
///
/// Once vaccine-add-new.mxe (or a live tree dump) is available, wiring
/// the real sequence is: replace NavigateToVaccineFieldsStep /
/// InputVaccineCodeStep / InputLotAndExpirationStep / ConfirmEntryStep's
/// bodies with real FlaUI Invoke/SetValue calls against
/// context.AttachedWindow — no change needed to PioneerEntrySequenceRunner,
/// IPioneerEntrySequence, or any caller (DataEntryPopupViewModel).
/// </summary>
public sealed class PlaceholderVaccineEntrySequence : IPioneerEntrySequence
{
    public string Name => "Vaccine entry (PENDING-MACRO-FILE placeholder)";

    public IReadOnlyList<IPioneerEntryStep> Steps { get; } = new IPioneerEntryStep[]
    {
        new FocusPioneerWindowStep(),
        new NavigateToVaccineFieldsStep(),
        new InputVaccineCodeStep(),
        new InputLotAndExpirationStep(),
        new ConfirmEntryStep(),
    };
}
