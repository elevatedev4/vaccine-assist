using System;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// Types the lot number and expiration date directly into PioneerRx's
/// dispensed-drug panel — unlike the physician/drug fields, these are
/// plain text entry (no ENTER-driven search/select) in the live dumps, so
/// no keypress follows SetValue.
///
/// FIELD TARGETS (confirmed against the live "Add New Rx" UIA dumps, all
/// inside the Dispense tab's uxRxTransactionDispensedDrugPanel):
///   - Lot: Edit, name='Lot:', AutomationId='uxLotNumber', patterns=[Value]
///     (dump line ~741, blank on the empty form; populated with
///     "testlot" only in the LAST progressive-state dump — after the
///     physician + drug fields were already resolved, matching this
///     step's place in the sequence).
///   - Expiration: Edit, name='Exp:', AutomationId='uxLotExpirationDate',
///     patterns=[Value] (dump line ~750, populated with "9/5/2027" in
///     that same last dump).
///
/// DATE FORMAT: the live value ("9/5/2027") is PioneerRx's own date-edit
/// format — M/d/yyyy, no leading zeros — NOT the MMDDYYYY macro format
/// VaccineEntryPayload.ExpirationMacroFormat carries (kept in that format
/// because it's also used by ToClipboardPayload's macro-era fallback
/// string). ToPioneerDateFormat below converts MMDDYYYY -> M/d/yyyy
/// before typing; if the stored value doesn't parse as MMDDYYYY (should
/// never happen — Models.Lot.ExpirationMacroFormat always produces it),
/// this step fails with a named reason rather than typing something
/// PioneerRx's masked date field might silently mangle.
/// </summary>
public sealed class InputLotAndExpirationStep : IPioneerEntryStep
{
    public const string LotNumberAutomationId = "uxLotNumber";
    public const string LotExpirationAutomationId = "uxLotExpirationDate";

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
                $"Would type lot \"{context.Payload.LotNumber}\" into '{LotNumberAutomationId}' and expiration " +
                $"\"{context.Payload.ExpirationMacroFormat}\" into '{LotExpirationAutomationId}' (no PioneerRx call made)."));
        }

        if (context.AttachedWindow is null)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                "No PioneerRx window attached — FocusPioneerWindowStep must run (and succeed) before this step."));
        }

        var lotOutcome = QuickSearchFieldEntry.TypeAndConfirm(
            context.AttachedWindow, LotNumberAutomationId, "lot number", context.Payload.LotNumber, enterPresses: 0);
        if (!lotOutcome.Success)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: false, DryRun: false, lotOutcome.Message));
        }

        var pioneerExpiration = ToPioneerDateFormat(context.Payload.ExpirationMacroFormat);
        if (pioneerExpiration is null)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                $"Lot number entered, but couldn't parse expiration \"{context.Payload.ExpirationMacroFormat}\" as MMDDYYYY — not typed into '{LotExpirationAutomationId}'."));
        }

        var expirationOutcome = QuickSearchFieldEntry.TypeAndConfirm(
            context.AttachedWindow, LotExpirationAutomationId, "expiration date", pioneerExpiration, enterPresses: 0);
        if (!expirationOutcome.Success)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                $"Lot number entered, but expiration failed: {expirationOutcome.Message}"));
        }

        return Task.FromResult(new PioneerEntryStepResult(Name, Success: true, DryRun: false,
            $"Entered lot \"{context.Payload.LotNumber}\" and expiration \"{pioneerExpiration}\"."));
    }

    /// <summary>MMDDYYYY (Models.Lot.ExpirationMacroFormat) -> PioneerRx's
    /// own M/d/yyyy date-edit format (confirmed against the live dump's
    /// uxLotExpirationDate value, "9/5/2027"). Public + pure for unit
    /// testing without a live UIA session — see
    /// InputLotAndExpirationStepDateFormatTests.cs.</summary>
    public static string? ToPioneerDateFormat(string macroFormatExpiration)
    {
        return DateTime.TryParseExact(
            macroFormatExpiration, "MMddyyyy", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed)
            ? parsed.ToString("M/d/yyyy", CultureInfo.InvariantCulture)
            : null;
    }
}
