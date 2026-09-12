using System;
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
/// VERBATIM STRING, NOT A NUMBER: REVIEWER FIX (2026-09-07) —
/// vaccine.quantity is a `text` column, not numeric
/// (supabase/migrations/0009_lots_bud_vaccine_defaults.sql lines 26-30:
/// free-text because Pioneer's own quantity field accepts arbitrary
/// strings like "0.5 mL" or "1 dose IM x1", not a single unit type). This
/// step used to parse/format Models.Vaccine.Quantity as a decimal — wrong,
/// and would have hard-crashed deserialization the moment a real,
/// non-numeric quantity string reached VaccineApiService (see
/// Models/Vaccine.cs's own doc comment). Now types whatever string is on
/// file exactly as entered, no parsing/reformatting.
///
/// NULL/BLANK QUANTITY — REWORKED (V-..., 2026-09-10, Will 2026-09-09/10:
/// "made it through to quantity (slowly) and stopped at quantity (not
/// entered)"): every vaccine row currently has a null Quantity on file
/// (the cloud vaccines API confirms this), so the OLD "skip silently"
/// behavior below WAS the "stopped at quantity" symptom he saw — nothing
/// was ever wrong, the step was quietly doing nothing every single run.
/// Now prompts (PioneerEntryStepContext.RequestTextPrompt — see that
/// property's own doc comment) instead of skipping: Continue types
/// whatever was entered (same as if it had been on file all along) AND
/// saves it back onto the vaccine's catalog record via
/// PioneerEntryStepContext.SaveQuantityAsync, so the next run for this
/// vaccine has it on file and never has to ask again. Cancel aborts the
/// whole entry with a named reason. The prompt has no Skip option (unlike
/// InputDirectionsStep) — there's no legitimate "leave the quantity field
/// untouched and move on" outcome for a vaccine administration record the
/// way there is for directions/SIG.
/// </summary>
public sealed class InputQuantityStep : IPioneerEntryStep
{
    public const string QuantityAutomationId = "uxQuantityPrescribed";

    public string Name => "Enter quantity";

    public async Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
    {
        var quantityText = context.Payload.Quantity;

        if (string.IsNullOrWhiteSpace(quantityText))
        {
            var prompt = RequestQuantity(context);
            if (prompt.Action != TextPromptAction.Continue)
            {
                return new PioneerEntryStepResult(Name, Success: false, DryRun: context.DryRun,
                    "Cancelled — no quantity on file for this vaccine and the quantity prompt was cancelled. Entry stopped.");
            }

            quantityText = prompt.Value;
            await SaveQuantityBackToVaccineAsync(context, quantityText);
        }

        if (context.DryRun)
        {
            return new PioneerEntryStepResult(Name, Success: true, DryRun: true,
                $"Would type quantity \"{quantityText}\" into '{QuantityAutomationId}' (no PioneerRx call made).");
        }

        if (context.AttachedWindow is null)
        {
            return new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                "No PioneerRx window attached — FocusPioneerWindowStep must run (and succeed) before this step.");
        }

        // V-..., 2026-09-11: same "wait for found AND enabled before the
        // one-shot lookup" hardening SelectPrescriberStep/InputVaccineCodeStep/
        // InputLotAndExpirationStep already got — this step used to do a
        // one-shot TypeAndConfirmAsync lookup straight away, which is
        // exactly the shape that failed for the prescriber field (see
        // QuickSearchFieldEntry.WaitForFieldAsync's own doc comment).
        await QuickSearchFieldEntry.WaitForFieldAsync(
            context.AttachedWindow, QuantityAutomationId, QuickSearchFieldEntry.DefaultFieldWaitTimeout,
            context.Log, cancellationToken);

        var outcome = await QuickSearchFieldEntry.TypeAndConfirmAsync(
            context.AttachedWindow, QuantityAutomationId, "quantity", quantityText, enterPresses: 0,
            log: context.Log, cancellationToken: cancellationToken);

        return new PioneerEntryStepResult(Name, outcome.Success, DryRun: false, outcome.Message);
    }

    /// <summary>Shows the blank-quantity prompt — see
    /// PioneerEntryStepContext.RequestTextPrompt's own doc comment for the
    /// "fails closed to Cancel when unwired" posture. Shown regardless of
    /// DryRun: a dry run is only about whether the FINAL typing into
    /// PioneerRx happens for real, not about whether staff gets asked for
    /// a value that's genuinely missing — this also lets the prompt be
    /// exercised on a machine with no PioneerRx installed.</summary>
    private static TextPromptResult RequestQuantity(PioneerEntryStepContext context)
    {
        if (context.RequestTextPrompt is null) return TextPromptResult.Cancelled;

        var vaccineName = string.IsNullOrWhiteSpace(context.Payload.VaccineName) ? "this vaccine" : context.Payload.VaccineName;
        return context.RequestTextPrompt(
            $"Quantity needed for {vaccineName}",
            "No quantity is on file for this vaccine. Enter the quantity to use for this administration:",
            false);
    }

    /// <summary>Saves a quantity the prompt above just collected back onto
    /// the vaccine's catalog record — a FAILED save must not abort the
    /// entry (Will's brief, verbatim), so this only ever logs the outcome,
    /// never returns/throws a failure the caller has to handle.</summary>
    private async Task SaveQuantityBackToVaccineAsync(PioneerEntryStepContext context, string quantityText)
    {
        if (context.SaveQuantityAsync is null) return;

        try
        {
            var saved = await context.SaveQuantityAsync(quantityText);
            context.Log(saved
                ? $"[{Name}] Saved quantity \"{quantityText}\" back onto the vaccine catalog record."
                : $"[{Name}] Couldn't save quantity \"{quantityText}\" back onto the vaccine catalog record — continuing with entry anyway.");
        }
        catch (Exception ex)
        {
            context.Log($"[{Name}] Couldn't save quantity \"{quantityText}\" back onto the vaccine catalog record: {ex.Message} — continuing with entry anyway.");
        }
    }
}
