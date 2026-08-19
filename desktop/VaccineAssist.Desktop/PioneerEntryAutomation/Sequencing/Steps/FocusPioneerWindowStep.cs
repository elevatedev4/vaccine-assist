using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Uia;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// Step 1 of PlaceholderVaccineEntrySequence: find + attach to the
/// PioneerRx window via UIA (PioneerRxAttachment — see that file's doc
/// for the title caveat). This step is REAL, not a placeholder — focusing
/// the window doesn't depend on knowing the vaccine entry form's exact
/// field layout, unlike the steps after it.
/// </summary>
public sealed class FocusPioneerWindowStep : IPioneerEntryStep
{
    public string Name => "Focus PioneerRx window";

    public Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
    {
        if (context.DryRun)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: true, DryRun: true,
                "Would locate and focus the PioneerRx window (no PioneerRx call made)."));
        }

        var window = PioneerRxAttachment.TryAttach();
        if (window is null)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                "No PioneerRx window found — open the patient's Rx profile before entering data."));
        }

        context.AttachedWindow = window;
        return Task.FromResult(new PioneerEntryStepResult(Name, Success: true, DryRun: false, "Attached to PioneerRx window."));
    }
}
