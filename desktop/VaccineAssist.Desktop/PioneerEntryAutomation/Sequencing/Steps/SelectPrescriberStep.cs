using System.Threading;
using System.Threading.Tasks;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// Types the resolved protocol physician's Pioneer "alternate ID" into
/// the prescriber quick-search field, then presses ENTER twice to select
/// that prescriber — Will's own described workflow (2026-09-05): "On the
/// physician line, you would enter the alternate ID, then push enter
/// twice to select that prescriber."
///
/// FIELD TARGET (confirmed against the live "Add New Rx" UIA dumps):
/// Edit, name='Written By:', AutomationId='uxPrescriberQuickSearch',
/// class='WindowsForms10.EDIT...', patterns=[Value], inside
/// Pane id='uxPrescriberPanel' (dump line ~812, blank on the empty form;
/// dump line ~2172 shows it populated with a resolved prescriber name
/// after this same workflow was exercised live — no separate "select
/// prescriber" popup window appears in between, see
/// QuickSearchFieldEntry's doc comment). The SAME AutomationId
/// (uxPrescriberQuickSearch) is independently confirmed by rx-verify's
/// FieldMap.EnteredPrescriberQuickSearchId, reading the identical panel on
/// PioneerRx's Edit Rx / Pre-Check Rx screens against ITS OWN two live
/// dumps — cross-confirmation from a second, already-shipped
/// PioneerRx automation.
///
/// PRECONDITION: FocusPioneerWindowStep has already attached to a
/// PioneerRx window showing an Rx Profile or an in-progress Add New Rx
/// (context.AttachedWindow is non-null) — this step does not itself
/// navigate/open anything (unlike the OLD macro-era placeholder this
/// replaces, "NavigateToVaccineFieldsStep": the real Add New Rx screen
/// has every field already visible with no navigation step needed, per
/// the live dumps).
///
/// RENAMED from NavigateToVaccineFieldsStep (was PENDING-MACRO-FILE) —
/// see PlaceholderVaccineEntrySequence's doc comment for why the
/// containing class name wasn't also changed.
/// </summary>
public sealed class SelectPrescriberStep : IPioneerEntryStep
{
    public const string PrescriberQuickSearchAutomationId = "uxPrescriberQuickSearch";
    private const int EnterPresses = 2;

    public string Name => "Select prescriber";

    public Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
    {
        if (context.DryRun)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: true, DryRun: true,
                $"Would type physician alternate ID \"{context.Payload.PhysicianAlternateId}\" into the prescriber field " +
                $"(AutomationId '{PrescriberQuickSearchAutomationId}') and press ENTER twice (no PioneerRx call made)."));
        }

        if (context.AttachedWindow is null)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                "No PioneerRx window attached — FocusPioneerWindowStep must run (and succeed) before this step."));
        }

        if (string.IsNullOrWhiteSpace(context.Payload.PhysicianAlternateId))
        {
            // Belt-and-suspenders: DataEntryPopupViewModel.BuildLivePayloadAsync
            // is supposed to block the whole entry before a payload with no
            // resolved physician ever reaches a live sequence run.
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                "No protocol physician alternate ID on the payload — entry should have been blocked before this sequence ran."));
        }

        var outcome = QuickSearchFieldEntry.TypeAndConfirm(
            context.AttachedWindow, PrescriberQuickSearchAutomationId, "prescriber",
            context.Payload.PhysicianAlternateId, EnterPresses);

        return Task.FromResult(new PioneerEntryStepResult(Name, outcome.Success, DryRun: false, outcome.Message));
    }
}
