using System;
using System.Threading;
using System.Threading.Tasks;
using FlaUI.Core.AutomationElements;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// SAFETY (Will's brief, explicit): "NEVER auto-confirm a final save
/// unless the dump shows an explicit, unambiguous confirm control — if
/// ambiguous, stop the sequence BEFORE final save... this writes to his
/// real pharmacy system." The live dumps DO show an explicit, unambiguous
/// control — Button, name='Save &amp; Continue - F12',
/// AutomationId='uxSave' (dump line ~899, in the Add New Rx screen's
/// bottom status panel, patterns=[Invoke]) — but clicking it does more
/// than "confirm this vaccine's data": it submits the ENTIRE new Rx into
/// PioneerRx's real fill/pre-check pipeline (the same dump shows
/// "Send to Pre-check" / "Waiting for Data Entry" workflow-status text
/// right next to it), which is a bigger, less reversible action than the
/// field entry the earlier steps perform. So this step CONFIRMS the
/// button exists and is invokable, but deliberately does NOT click it —
/// this is the "stop the sequence BEFORE final save" half of the brief,
/// applied even though the control itself isn't ambiguous. Flagged
/// explicitly in the change that introduced this as a judgment call worth
/// Will's confirmation: if he'd rather this DOES click Save & Continue
/// once everything above it succeeds, that's a one-line change here (add
/// the Invoke call) once he's confirmed that's what he wants.
///
/// Does NOT cover the Medicare home-visit special case (macro lines
/// 79-80, 322-325 from the pre-automation .mxe era) — see
/// PioneerEntryAutomation/TODO.md item 3; still undesigned pending a live
/// target for that flow specifically.
/// </summary>
public sealed class ConfirmEntryStep : IPioneerEntryStep
{
    public const string SaveButtonAutomationId = "uxSave";

    public string Name => "Confirm entry";

    public Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
    {
        if (context.DryRun)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: true, DryRun: true,
                $"Would locate the \"Save & Continue\" button (AutomationId '{SaveButtonAutomationId}') and STOP without clicking it — " +
                "review and press Save & Continue (F12) in Pioneer yourself (no PioneerRx call made)."));
        }

        if (context.AttachedWindow is null)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                "No PioneerRx window attached — FocusPioneerWindowStep must run (and succeed) before this step."));
        }

        AutomationElement? saveButton;
        try
        {
            saveButton = context.AttachedWindow.FindFirstDescendant(cf => cf.ByAutomationId(SaveButtonAutomationId));
        }
        catch (Exception ex)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                $"Couldn't search for the \"Save & Continue\" button (AutomationId '{SaveButtonAutomationId}'): {ex.Message}"));
        }

        if (saveButton is null)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                $"Couldn't find the \"Save & Continue\" button (AutomationId '{SaveButtonAutomationId}') — " +
                "the fields above may have entered correctly, but this couldn't confirm where to save. Review Pioneer directly."));
        }

        return Task.FromResult(new PioneerEntryStepResult(Name, Success: true, DryRun: false,
            "Fields entered. Found the \"Save & Continue\" button but did NOT click it — review the entry and press Save & Continue (F12) in Pioneer yourself."));
    }
}
