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
        // V-... Part C (expiration gate): staff explicitly chose "Leave
        // lot/expiration blank and proceed" on the popup because no
        // unexpired lot was on file — see VaccineEntryPayload.SkipLotAndExpiration's
        // doc comment. Checked FIRST, ahead of DryRun, so a skip behaves
        // identically (succeeds, does nothing) whether or not PioneerRx is
        // attached, same as every other step's dry-run-first check.
        if (context.Payload.SkipLotAndExpiration)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: true, DryRun: context.DryRun,
                "Skipped — lot/expiration intentionally left blank (no unexpired lot was on file; staff chose to proceed without one)."));
        }

        if (context.DryRun)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: true, DryRun: true,
                $"Would press ALT+O, type lot \"{context.Payload.LotNumber}\", TAB, type expiration \"{context.Payload.ExpirationMacroFormat}\" (no PioneerRx call made)."));
        }

        return Task.FromResult(new PioneerEntryStepResult(Name, Success: false, DryRun: false, PendingMacroFile.Message));
    }
}
