using System.Threading;
using System.Threading.Tasks;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// PENDING-MACRO-FILE placeholder: the macro's final confirm keystrokes —
/// type the administration-site code ("w"/Payload.AdminSiteDisplayText's
/// macro code), TAB through. See NavigateToVaccineFieldsStep's doc — same
/// caveat, same reason (vaccine-add-new.mxe lines 298-337). Does NOT
/// cover the Medicare home-visit special case (macro lines 79-80,
/// 322-325) — see PioneerEntryAutomation/TODO.md item 3; still
/// undesigned pending a live target.
/// </summary>
public sealed class ConfirmEntryStep : IPioneerEntryStep
{
    public string Name => "Confirm entry";

    public Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
    {
        if (context.DryRun)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: true, DryRun: true,
                $"Would type admin site \"{context.Payload.AdminSiteDisplayText}\", press TAB, \"w\" to confirm, TAB (no PioneerRx call made)."));
        }

        return Task.FromResult(new PioneerEntryStepResult(Name, Success: false, DryRun: false, PendingMacroFile.Message));
    }
}
