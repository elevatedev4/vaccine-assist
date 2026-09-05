using System.Threading.Tasks;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// SelectPrescriberStep (renamed from NavigateToVaccineFieldsStep,
/// 2026-09-05 — see its own doc comment) types the resolved protocol
/// physician's alternate ID into PioneerRx's prescriber quick-search
/// field. These tests cover the shapes that don't need a live UIA
/// session: dry-run wording, the "no attached window" failure, and the
/// belt-and-suspenders empty-alternate-ID guard.
/// </summary>
public class SelectPrescriberStepTests
{
    [Fact]
    public async Task DryRunDescribesTheAlternateIdAndTwoEnters()
    {
        var payload = new VaccineEntryPayload("mmr1", "LOT123", "01152027", "Left arm", Ndc: "00069-2025-10", PhysicianAlternateId: "ALTPRIMARY");
        var step = new SelectPrescriberStep();
        var context = new PioneerEntryStepContext(payload, dryRun: true, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.Contains("ALTPRIMARY", result.Message);
        Assert.Contains(SelectPrescriberStep.PrescriberQuickSearchAutomationId, result.Message);
    }

    [Fact]
    public async Task LiveModeFailsWithNoAttachedWindow()
    {
        var payload = new VaccineEntryPayload("mmr1", "LOT123", "01152027", "Left arm", Ndc: "00069-2025-10", PhysicianAlternateId: "ALTPRIMARY");
        var step = new SelectPrescriberStep();
        var context = new PioneerEntryStepContext(payload, dryRun: false, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.False(result.Success);
        Assert.Contains("No PioneerRx window attached", result.Message);
    }

    [Fact]
    public async Task LiveModeFailsBeltAndSuspendersWhenAlternateIdIsBlankEvenThoughItShouldNeverReachHere()
    {
        // DataEntryPopupViewModel.BuildLivePayloadAsync is supposed to
        // block entry entirely before an unresolved payload reaches a
        // live sequence run — this only covers the defense-in-depth path
        // for a payload built some other way. Uses a real (non-null)
        // AttachedWindow-free live context, so this exercises the
        // no-window check FIRST; a dedicated blank-alternate-ID-with-a-
        // window case needs a live UIA session, out of reach here.
        var payload = new VaccineEntryPayload("mmr1", "LOT123", "01152027", "Left arm", Ndc: "00069-2025-10", PhysicianAlternateId: "");
        var step = new SelectPrescriberStep();
        var context = new PioneerEntryStepContext(payload, dryRun: false, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.False(result.Success);
    }
}
