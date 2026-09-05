using System.Threading.Tasks;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-... Part C: VaccineEntryPayload.SkipLotAndExpiration ("Leave
/// lot/expiration blank and proceed" — no unexpired lot was on file for the
/// selected vaccine) must make InputLotAndExpirationStep succeed as a no-op
/// instead of touching PioneerRx at all, in BOTH dry-run and live mode —
/// see the step's own ExecuteAsync doc comment. Rewritten 2026-09-05 for
/// the step's real (non-placeholder) live-mode behavior — see
/// InputLotAndExpirationStepDateFormatTests.cs for ToPioneerDateFormat's
/// own pure-logic coverage.
/// </summary>
public class InputLotAndExpirationStepSkipTests
{
    private static PioneerEntryStepContext MakeContext(VaccineEntryPayload payload, bool dryRun) =>
        new(payload, dryRun, _ => { });

    [Fact]
    public async Task SkippedPayloadSucceedsInDryRunWithoutTheUsualDryRunMessage()
    {
        var payload = new VaccineEntryPayload("mmr1", "", "", "Left arm", SkipLotAndExpiration: true);
        var step = new InputLotAndExpirationStep();

        var result = await step.ExecuteAsync(MakeContext(payload, dryRun: true));

        Assert.True(result.Success);
        Assert.Contains("Skipped", result.Message);
        Assert.DoesNotContain("Would type lot", result.Message);
    }

    [Fact]
    public async Task SkippedPayloadSucceedsInLiveModeWithoutTouchingPioneerRxAtAll()
    {
        var payload = new VaccineEntryPayload("mmr1", "", "", "Left arm", SkipLotAndExpiration: true);
        var step = new InputLotAndExpirationStep();

        // No AttachedWindow at all — if the skip check weren't FIRST (see
        // the step's own doc comment), this would fail on "no attached
        // window" instead of skipping.
        var result = await step.ExecuteAsync(MakeContext(payload, dryRun: false));

        Assert.True(result.Success);
        Assert.Contains("Skipped", result.Message);
    }

    [Fact]
    public async Task NonSkippedPayloadNowHitsTheRealNoAttachedWindowFailure()
    {
        // Regression guard: adding the skip check must not change behavior
        // for the existing (non-skip) path — see PlaceholderVaccineEntrySequenceTests.cs
        // for the equivalent whole-sequence coverage. Rewritten from the
        // old PENDING-MACRO-FILE-era expectation: the step is real now, so
        // with no AttachedWindow set, it fails with its own specific
        // "no attached window" message instead of a generic stub.
        var payload = new VaccineEntryPayload("mmr1", "LOT123", "01152027", "Left arm");
        var step = new InputLotAndExpirationStep();

        var dryRunResult = await step.ExecuteAsync(MakeContext(payload, dryRun: true));
        Assert.True(dryRunResult.Success);
        Assert.Contains("Would type lot", dryRunResult.Message);

        var liveResult = await step.ExecuteAsync(MakeContext(payload, dryRun: false));
        Assert.False(liveResult.Success);
        Assert.Contains("No PioneerRx window attached", liveResult.Message);
    }
}
