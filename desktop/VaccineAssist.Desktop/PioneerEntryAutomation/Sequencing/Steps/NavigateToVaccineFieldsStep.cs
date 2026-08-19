using System.Threading;
using System.Threading.Tasks;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// PENDING-MACRO-FILE placeholder: the macro's own equivalent is ESC then
/// opening the product-search field (see PioneerEntryAutomation/TODO.md,
/// "shape to fill in" #2, citing vaccine-add-new.mxe lines 298-337). The
/// exact UIA control to navigate to isn't known yet. Structure, logging,
/// and error handling are real; only the actual field target is stubbed.
/// </summary>
public sealed class NavigateToVaccineFieldsStep : IPioneerEntryStep
{
    public string Name => "Navigate to vaccine entry fields";

    public Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
    {
        if (context.DryRun)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: true, DryRun: true,
                "Would press ESC and open the product-search field (no PioneerRx call made)."));
        }

        return Task.FromResult(new PioneerEntryStepResult(Name, Success: false, DryRun: false, PendingMacroFile.Message));
    }
}
