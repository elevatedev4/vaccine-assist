using System.Threading;
using System.Threading.Tasks;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// Types the vaccine's NDC into the drug quick-search field, then presses
/// ENTER twice to select that product — Will's own described workflow
/// (2026-09-05): "Same for drug... use NDC then enter twice."
///
/// FIELD TARGET (confirmed against the live "Add New Rx" UIA dumps): Edit,
/// name='Item:', AutomationId='uxPrescribedItemQuickSearch',
/// class='WindowsForms10.EDIT...', patterns=[Value], inside the
/// "Original" Rx details panel's prescribed-drug section (dump line
/// ~838, blank on the empty form; dump line ~2198 shows it populated with
/// the resolved drug description after this workflow was exercised live —
/// same "no separate popup window" shape as the prescriber field, see
/// QuickSearchFieldEntry's doc comment). AutomationId cross-confirmed by
/// rx-verify's FieldMap.EnteredItemQuickSearchId reading the identical
/// panel on PioneerRx's Edit Rx / Pre-Check Rx screens.
///
/// NOT USED: uxDispensedItem (a second, separately-addressable Edit with
/// the same name='Item:' on the Dispense tab's right-hand panel, dump
/// line ~743) — both real dumps show it mirrors uxPrescribedItemQuickSearch
/// automatically once a drug is selected (both went from blank to the
/// identical resolved value together), so typing into ONE field is
/// sufficient; Will's own description only ever mentions one action here.
///
/// NOT USED: Quantity/Days-Supply/Refills (uxDispensedQuantity,
/// uxDaysSupply, uxQuantityPrescribed) — the same live dumps show these
/// auto-populate from the drug record the moment it's resolved (e.g.
/// Comirnaty's quantity 0.3 / days-supply 1 appeared with no separate
/// typing action), so per the brief's "only wire what the dumps support —
/// do NOT invent fields", no step types into them.
/// </summary>
public sealed class InputVaccineCodeStep : IPioneerEntryStep
{
    public const string PrescribedItemQuickSearchAutomationId = "uxPrescribedItemQuickSearch";
    private const int EnterPresses = 2;

    public string Name => "Enter vaccine product code";

    public Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
    {
        if (context.DryRun)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: true, DryRun: true,
                $"Would type NDC \"{context.Payload.Ndc}\" into the drug field " +
                $"(AutomationId '{PrescribedItemQuickSearchAutomationId}') and press ENTER twice (no PioneerRx call made)."));
        }

        if (context.AttachedWindow is null)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                "No PioneerRx window attached — FocusPioneerWindowStep must run (and succeed) before this step."));
        }

        if (string.IsNullOrWhiteSpace(context.Payload.Ndc))
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                "This vaccine has no NDC on file (Models.Vaccine.Ndc) — add one in the vaccine catalog before entering it into PioneerRx."));
        }

        var outcome = QuickSearchFieldEntry.TypeAndConfirm(
            context.AttachedWindow, PrescribedItemQuickSearchAutomationId, "drug/NDC",
            context.Payload.Ndc, EnterPresses);

        return Task.FromResult(new PioneerEntryStepResult(Name, outcome.Success, DryRun: false, outcome.Message));
    }
}
