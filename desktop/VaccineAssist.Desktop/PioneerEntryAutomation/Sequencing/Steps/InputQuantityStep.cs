using System.Globalization;
using System.Threading;
using System.Threading.Tasks;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// Types the vaccine's quantity into PioneerRx's "Add New Rx" quantity
/// field — Will's brief (2026-09-07): "did not yet enter the quantity...
/// Each vaccine will have its own quantity."
///
/// FIELD TARGET: uxQuantityPrescribed — the SAME AutomationId
/// InputVaccineCodeStep's own doc comment already confirmed against the
/// live "Add New Rx" UIA dumps (2026-09-05), where it was deliberately
/// left untyped because the dumps showed it auto-populating from the
/// resolved drug record. That earlier decision is REVERSED here per
/// Will's explicit new instruction: a per-vaccine Quantity (Models.Vaccine.Quantity)
/// must be entered explicitly rather than trusting whatever PioneerRx
/// auto-fills, since a drug record's own default quantity does not
/// necessarily match what THIS vaccine's protocol calls for. Flagged as a
/// judgment call worth Will's live confirmation: the field target itself
/// is confirmed real, but typing into it (overwriting an auto-populated
/// value) has not been exercised live.
///
/// NULL QUANTITY: skips (succeeds, types nothing) rather than typing a
/// placeholder — Models.Vaccine.Quantity is null when the vaccines.quantity
/// migration (owned by a parallel change, see PioneerEntryAutomation/TODO.md's
/// 2026-09-07 entry) hasn't run yet, or when a specific vaccine simply has
/// no quantity on file yet.
/// </summary>
public sealed class InputQuantityStep : IPioneerEntryStep
{
    public const string QuantityAutomationId = "uxQuantityPrescribed";

    public string Name => "Enter quantity";

    public Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
    {
        if (context.Payload.Quantity is not decimal quantity)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: true, DryRun: context.DryRun,
                "Skipped — no quantity on file for this vaccine (Models.Vaccine.Quantity is null). Nothing typed into Pioneer."));
        }

        var quantityText = quantity.ToString("0.####", CultureInfo.InvariantCulture);

        if (context.DryRun)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: true, DryRun: true,
                $"Would type quantity \"{quantityText}\" into '{QuantityAutomationId}' (no PioneerRx call made)."));
        }

        if (context.AttachedWindow is null)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                "No PioneerRx window attached — FocusPioneerWindowStep must run (and succeed) before this step."));
        }

        var outcome = QuickSearchFieldEntry.TypeAndConfirm(
            context.AttachedWindow, QuantityAutomationId, "quantity", quantityText, enterPresses: 0);

        return Task.FromResult(new PioneerEntryStepResult(Name, outcome.Success, DryRun: false, outcome.Message));
    }
}
