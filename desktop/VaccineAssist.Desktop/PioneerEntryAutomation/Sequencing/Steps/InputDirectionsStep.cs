using System.Threading;
using System.Threading.Tasks;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// Types the vaccine's directions/sig into PioneerRx's "Add New Rx"
/// directions field — Will's brief (2026-09-07): "did not yet enter the
/// quantity, directions, lot, or expiration."
///
/// FIELD TARGET: uxDirections — NOT CONFIRMED against a live UIA dump
/// (unlike uxQuantityPrescribed, uxPrescriberQuickSearch,
/// uxPrescribedItemQuickSearch, uxLotNumber, uxLotExpirationDate, and
/// uxSave, all of which the 2026-09-05 dumps confirmed — see
/// PioneerEntryAutomation/TODO.md). This is a PLACEHOLDER AutomationId —
/// no directions/sig field appeared in any of the six dumps collected so
/// far, likely because none of those captures got far enough into the
/// form to show it. CONFIRM AGAINST A LIVE UIA DUMP OF THE DIRECTIONS
/// FIELD (the "Dump Pioneer UIA tree" button — see Uia/UiaTreeDumper.cs)
/// before relying on this in a live run; rename this constant (and update
/// this doc comment) once the real AutomationId is known — PioneerRx may
/// call it something else entirely (e.g. a "Sig" field).
///
/// NULL DIRECTIONS: skips (succeeds, types nothing) rather than typing a
/// placeholder — same posture as InputQuantityStep for a null
/// Models.Vaccine.Directions (migration not applied yet, or simply unset).
/// </summary>
public sealed class InputDirectionsStep : IPioneerEntryStep
{
    public const string DirectionsAutomationId = "uxDirections";

    public string Name => "Enter directions";

    public async Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(context.Payload.Directions))
        {
            return new PioneerEntryStepResult(Name, Success: true, DryRun: context.DryRun,
                "Skipped — no directions on file for this vaccine (Models.Vaccine.Directions is null/blank). Nothing typed into Pioneer.");
        }

        var directions = context.Payload.Directions;

        if (context.DryRun)
        {
            return new PioneerEntryStepResult(Name, Success: true, DryRun: true,
                $"Would type directions \"{directions}\" into '{DirectionsAutomationId}' (UNCONFIRMED AutomationId — no PioneerRx call made).");
        }

        if (context.AttachedWindow is null)
        {
            return new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                "No PioneerRx window attached — FocusPioneerWindowStep must run (and succeed) before this step.");
        }

        var outcome = await QuickSearchFieldEntry.TypeAndConfirmAsync(
            context.AttachedWindow, DirectionsAutomationId, "directions", directions, enterPresses: 0,
            log: context.Log, cancellationToken: cancellationToken);

        return new PioneerEntryStepResult(Name, outcome.Success, DryRun: false, outcome.Message);
    }
}
