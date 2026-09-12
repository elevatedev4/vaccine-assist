using System;
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
/// NULL/BLANK DIRECTIONS — REWORKED (V-..., 2026-09-10, Will 2026-09-09/10:
/// entry "stopped at quantity"): every vaccine row currently has blank
/// Directions on file, so — same root cause as InputQuantityStep's own
/// rework — the OLD "skip silently" behavior below was invisible, not
/// correct. Now prompts (PioneerEntryStepContext.RequestTextPrompt) instead
/// of skipping, with THREE outcomes instead of Quantity's two:
///   - Continue: types whatever was entered AND saves it back onto the
///     vaccine's catalog record (PioneerEntryStepContext.SaveDirectionsAsync)
///     so the next run has it on file.
///   - Skip: leaves Pioneer's directions field untouched and moves on —
///     Will's brief, verbatim: "some workflows fill SIG later." Nothing
///     saved back either (there's nothing new to save).
///   - Cancel: aborts the whole entry with a named reason.
/// </summary>
public sealed class InputDirectionsStep : IPioneerEntryStep
{
    public const string DirectionsAutomationId = "uxDirections";

    public string Name => "Enter directions";

    public async Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
    {
        var directions = context.Payload.Directions;

        if (string.IsNullOrWhiteSpace(directions))
        {
            var prompt = RequestDirections(context);
            switch (prompt.Action)
            {
                case TextPromptAction.Cancel:
                    return new PioneerEntryStepResult(Name, Success: false, DryRun: context.DryRun,
                        "Cancelled — no directions on file for this vaccine and the directions prompt was cancelled. Entry stopped.");
                case TextPromptAction.Skip:
                    return new PioneerEntryStepResult(Name, Success: true, DryRun: context.DryRun,
                        "Skipped — staff chose to leave directions blank for now (some workflows fill SIG later). Nothing typed into Pioneer.");
                case TextPromptAction.Continue:
                default:
                    directions = prompt.Value;
                    await SaveDirectionsBackToVaccineAsync(context, directions);
                    break;
            }
        }

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

        // V-..., 2026-09-11: same "wait for found AND enabled before the
        // one-shot lookup" hardening SelectPrescriberStep/InputVaccineCodeStep/
        // InputLotAndExpirationStep already got — see
        // QuickSearchFieldEntry.WaitForFieldAsync's own doc comment for why
        // a one-shot lookup alone isn't a strong enough "ready" signal.
        await QuickSearchFieldEntry.WaitForFieldAsync(
            context.AttachedWindow, DirectionsAutomationId, QuickSearchFieldEntry.DefaultFieldWaitTimeout,
            context.Log, cancellationToken);

        var outcome = await QuickSearchFieldEntry.TypeAndConfirmAsync(
            context.AttachedWindow, DirectionsAutomationId, "directions", directions!, enterPresses: 0,
            log: context.Log, cancellationToken: cancellationToken);

        return new PioneerEntryStepResult(Name, outcome.Success, DryRun: false, outcome.Message);
    }

    /// <summary>Shows the blank-directions prompt with Skip offered — see
    /// PioneerEntryStepContext.RequestTextPrompt's own doc comment for the
    /// "fails closed to Cancel when unwired" posture. Shown regardless of
    /// DryRun — see InputQuantityStep.RequestQuantity's identical
    /// reasoning.</summary>
    private static TextPromptResult RequestDirections(PioneerEntryStepContext context)
    {
        if (context.RequestTextPrompt is null) return TextPromptResult.Cancelled;

        var vaccineName = string.IsNullOrWhiteSpace(context.Payload.VaccineName) ? "this vaccine" : context.Payload.VaccineName;
        return context.RequestTextPrompt(
            $"Directions (SIG) for {vaccineName}",
            "No directions are on file for this vaccine. Enter directions/SIG, or Skip to leave it blank for now:",
            true);
    }

    /// <summary>Saves directions the prompt above just collected back onto
    /// the vaccine's catalog record — a FAILED save must not abort the
    /// entry (same posture as InputQuantityStep.SaveQuantityBackToVaccineAsync),
    /// so this only ever logs the outcome.</summary>
    private async Task SaveDirectionsBackToVaccineAsync(PioneerEntryStepContext context, string directions)
    {
        if (context.SaveDirectionsAsync is null) return;

        try
        {
            var saved = await context.SaveDirectionsAsync(directions);
            context.Log(saved
                ? $"[{Name}] Saved directions \"{directions}\" back onto the vaccine catalog record."
                : $"[{Name}] Couldn't save directions \"{directions}\" back onto the vaccine catalog record — continuing with entry anyway.");
        }
        catch (Exception ex)
        {
            context.Log($"[{Name}] Couldn't save directions \"{directions}\" back onto the vaccine catalog record: {ex.Message} — continuing with entry anyway.");
        }
    }
}
