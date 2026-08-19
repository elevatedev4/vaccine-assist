using System.Threading;
using System.Threading.Tasks;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// PENDING-MACRO-FILE placeholder: opens the admin form (macro's ALT+O)
/// and types Payload.LotNumber / Payload.ExpirationMacroFormat into the
/// lot + expiration fields. See NavigateToVaccineFieldsStep's doc — same
/// caveat, same reason (vaccine-add-new.mxe lines 298-337).
/// </summary>
public sealed class InputLotAndExpirationStep : IPioneerEntryStep
{
    public string Name => "Enter lot and expiration";

    public Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
    {
        if (context.DryRun)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: true, DryRun: true,
                $"Would press ALT+O, type lot \"{context.Payload.LotNumber}\", TAB, type expiration \"{context.Payload.ExpirationMacroFormat}\" (no PioneerRx call made)."));
        }

        return Task.FromResult(new PioneerEntryStepResult(Name, Success: false, DryRun: false, PendingMacroFile.Message));
    }
}
