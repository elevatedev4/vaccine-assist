using System.Collections.Generic;
using System.Threading.Tasks;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// InputDirectionsStep types the vaccine's directions into a PLACEHOLDER
/// AutomationId — see its own doc comment for why this hasn't been
/// confirmed against a live UIA dump yet.
///
/// BLANK-DIRECTIONS REWORK (V-..., 2026-09-10, Will 2026-09-09/10: desktop
/// data entry "stopped at quantity" — every vaccine row currently has
/// blank Directions on file too, same root cause as InputQuantityStep's
/// own rework). A blank Directions now prompts
/// (PioneerEntryStepContext.RequestTextPrompt) with THREE outcomes instead
/// of Quantity's two: Continue (types + saves back), Skip (leaves
/// Pioneer's field untouched — "some workflows fill SIG later," Will's
/// brief verbatim — and never saves anything, since nothing new was
/// entered), Cancel (aborts the whole entry).
/// </summary>
public class InputDirectionsStepTests
{
    private static VaccineEntryPayload PayloadWithDirections(string? directions, string vaccineName = "Comirnaty 2025-26 12+") =>
        new("mmr1", "LOT123", "01152027", "Left arm", Ndc: "00069-2025-10", PhysicianAlternateId: "ALTPRIMARY",
            Directions: directions, VaccineName: vaccineName);

    [Fact]
    public async Task BlankDirectionsWithNoPromptWiredCancelsTheEntry()
    {
        var step = new InputDirectionsStep();
        var context = new PioneerEntryStepContext(PayloadWithDirections(null), dryRun: false, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.False(result.Success);
        Assert.Contains("Cancelled", result.Message);
        Assert.Contains("directions prompt was cancelled", result.Message);
    }

    [Fact]
    public async Task BlankDirectionsPromptOffersSkip()
    {
        var step = new InputDirectionsStep();
        var allowSkipSeen = false;
        var context = new PioneerEntryStepContext(PayloadWithDirections("   "), dryRun: true, _ => { })
        {
            RequestTextPrompt = (title, message, allowSkip) =>
            {
                allowSkipSeen = allowSkip;
                return TextPromptResult.Cancelled;
            },
        };

        await step.ExecuteAsync(context);

        Assert.True(allowSkipSeen);
    }

    [Fact]
    public async Task BlankDirectionsPromptTitleUsesTheVaccineNameFromThePayload()
    {
        var step = new InputDirectionsStep();
        string? capturedTitle = null;
        var context = new PioneerEntryStepContext(PayloadWithDirections(null, "Shingrix"), dryRun: true, _ => { })
        {
            RequestTextPrompt = (title, message, allowSkip) =>
            {
                capturedTitle = title;
                return TextPromptResult.Cancelled;
            },
        };

        await step.ExecuteAsync(context);

        Assert.Equal("Directions (SIG) for Shingrix", capturedTitle);
    }

    [Fact]
    public async Task BlankDirectionsSkippedAtThePromptSucceedsWithoutTypingOrSaving()
    {
        var step = new InputDirectionsStep();
        var saveCalled = false;
        var log = new List<string>();
        var context = new PioneerEntryStepContext(PayloadWithDirections(null), dryRun: true, log.Add)
        {
            RequestTextPrompt = (title, message, allowSkip) => TextPromptResult.Skipped,
            SaveDirectionsAsync = value => { saveCalled = true; return Task.FromResult(true); },
        };

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.Contains("Skipped", result.Message);
        Assert.Contains("fill SIG later", result.Message);
        Assert.False(saveCalled);
        // Skipped means nothing was typed — the dry-run description
        // branch (which would type "" per the old blank value) must never
        // run for this outcome.
        Assert.DoesNotContain(InputDirectionsStep.DirectionsAutomationId, result.Message);
    }

    [Fact]
    public async Task BlankDirectionsCancelledAtThePromptNeverCallsSave()
    {
        var step = new InputDirectionsStep();
        var saveCalled = false;
        var context = new PioneerEntryStepContext(PayloadWithDirections(null), dryRun: true, _ => { })
        {
            RequestTextPrompt = (title, message, allowSkip) => TextPromptResult.Cancelled,
            SaveDirectionsAsync = value => { saveCalled = true; return Task.FromResult(true); },
        };

        var result = await step.ExecuteAsync(context);

        Assert.False(result.Success);
        Assert.False(saveCalled);
    }

    [Fact]
    public async Task BlankDirectionsContinuedAtThePromptTypesAndSavesTheEnteredValue()
    {
        var step = new InputDirectionsStep();
        string? savedValue = null;
        var log = new List<string>();
        var context = new PioneerEntryStepContext(PayloadWithDirections(null), dryRun: true, log.Add)
        {
            RequestTextPrompt = (title, message, allowSkip) => TextPromptResult.Continued("IM in deltoid"),
            SaveDirectionsAsync = value => { savedValue = value; return Task.FromResult(true); },
        };

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.True(result.DryRun);
        Assert.Contains("IM in deltoid", result.Message);
        Assert.Equal("IM in deltoid", savedValue);
        Assert.Contains(log, line => line.Contains("Saved directions"));
    }

    [Fact]
    public async Task BlankDirectionsContinuedWithAFailedSaveStillSucceedsAndLogsIt()
    {
        var step = new InputDirectionsStep();
        var log = new List<string>();
        var context = new PioneerEntryStepContext(PayloadWithDirections(null), dryRun: true, log.Add)
        {
            RequestTextPrompt = (title, message, allowSkip) => TextPromptResult.Continued("IM in deltoid"),
            SaveDirectionsAsync = value => Task.FromResult(false),
        };

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.Contains(log, line => line.Contains("Couldn't save directions") && line.Contains("continuing"));
    }

    [Fact]
    public async Task DryRunDescribesTheDirections()
    {
        var step = new InputDirectionsStep();
        var context = new PioneerEntryStepContext(PayloadWithDirections("IM in deltoid"), dryRun: true, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.True(result.DryRun);
        Assert.Contains("IM in deltoid", result.Message);
        Assert.Contains(InputDirectionsStep.DirectionsAutomationId, result.Message);
    }

    [Fact]
    public async Task LiveModeFailsWithNoAttachedWindowWhenDirectionsAreSet()
    {
        var step = new InputDirectionsStep();
        var context = new PioneerEntryStepContext(PayloadWithDirections("IM in deltoid"), dryRun: false, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.False(result.Success);
        Assert.Contains("No PioneerRx window attached", result.Message);
    }
}
