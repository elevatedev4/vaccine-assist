using System.Threading;
using System.Threading.Tasks;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// PENDING-MACRO-FILE placeholder: types Payload.ShortCode + ENTER into
/// the product-search field the previous step navigated to. See
/// NavigateToVaccineFieldsStep's doc — same caveat, same reason.
/// </summary>
public sealed class InputVaccineCodeStep : IPioneerEntryStep
{
    public string Name => "Enter vaccine product code";

    public Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
    {
        if (context.DryRun)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: true, DryRun: true,
                $"Would type product code \"{context.Payload.ShortCode}\" and press ENTER (no PioneerRx call made)."));
        }

        return Task.FromResult(new PioneerEntryStepResult(Name, Success: false, DryRun: false, PendingMacroFile.Message));
    }
}
