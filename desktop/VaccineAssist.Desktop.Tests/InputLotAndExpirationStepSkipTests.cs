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
/// instead of hitting its usual PENDING-MACRO-FILE stub, in BOTH dry-run and
/// live mode — see the step's own ExecuteAsync doc comment.
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
        Assert.DoesNotContain("Would press ALT+O", result.Message);
    }

    [Fact]
    public async Task SkippedPayloadSucceedsInLiveModeInsteadOfThePendingMacroFileStub()
    {
        var payload = new VaccineEntryPayload("mmr1", "", "", "Left arm", SkipLotAndExpiration: true);
        var step = new InputLotAndExpirationStep();

        var result = await step.ExecuteAsync(MakeContext(payload, dryRun: false));

        Assert.True(result.Success);
        Assert.DoesNotContain("PENDING-MACRO-FILE", result.Message);
    }

    [Fact]
    public async Task NonSkippedPayloadStillHitsTheUsualStubBehaviorUnchanged()
    {
        // Regression guard: adding the skip check must not change behavior
        // for the existing (non-skip) path — see PlaceholderVaccineEntrySequenceTests.cs
        // for the equivalent whole-sequence coverage.
        var payload = new VaccineEntryPayload("mmr1", "LOT123", "01152027", "Left arm");
        var step = new InputLotAndExpirationStep();

        var dryRunResult = await step.ExecuteAsync(MakeContext(payload, dryRun: true));
        Assert.True(dryRunResult.Success);
        Assert.Contains("Would press ALT+O", dryRunResult.Message);

        var liveResult = await step.ExecuteAsync(MakeContext(payload, dryRun: false));
        Assert.False(liveResult.Success);
        Assert.Contains("PENDING-MACRO-FILE", liveResult.Message);
    }
}
