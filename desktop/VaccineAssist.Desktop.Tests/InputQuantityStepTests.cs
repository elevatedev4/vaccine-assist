using System.Collections.Generic;
using System.Threading.Tasks;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// InputQuantityStep types the vaccine's quantity into PioneerRx's Add New
/// Rx quantity field — see its own doc comment for the field target.
///
/// REVIEWER FIX (2026-09-07): vaccine.quantity is a `text` column, not
/// numeric (supabase/migrations/0009_lots_bud_vaccine_defaults.sql lines
/// 26-30 — Pioneer's own quantity field accepts arbitrary strings like
/// "0.5 mL" or "1 dose IM x1"). These tests use realistic free-text values
/// ("0.5 mL") rather than bare numbers to match.
///
/// BLANK-QUANTITY REWORK (V-..., 2026-09-10, Will 2026-09-09/10: "made it
/// through to quantity (slowly) and stopped at quantity (not entered)" —
/// every vaccine row currently has a null Quantity on file, so the OLD
/// "skip silently" behavior WAS the "stopped" symptom). A blank Quantity
/// now prompts (PioneerEntryStepContext.RequestTextPrompt) instead of
/// skipping — these tests replace the old
/// NullQuantitySkips/BlankQuantityAlsoSkips/NullQuantitySkipsEvenInDryRun
/// cases with the new prompt outcomes: no prompt wired (fails closed to
/// Cancel — same posture as ConfirmVarUpdateRequested), Continue (types +
/// saves back via SaveQuantityAsync), and Cancel (aborts, never saves).
/// </summary>
public class InputQuantityStepTests
{
    private static VaccineEntryPayload PayloadWithQuantity(string? quantity, string vaccineName = "Comirnaty 2025-26 12+") =>
        new("mmr1", "LOT123", "01152027", "Left arm", Ndc: "00069-2025-10", PhysicianAlternateId: "ALTPRIMARY",
            Quantity: quantity, VaccineName: vaccineName);

    [Fact]
    public async Task BlankQuantityWithNoPromptWiredCancelsTheEntry()
    {
        // RequestTextPrompt/SaveQuantityAsync are both left null — same
        // "fails closed when unwired" posture as ConfirmVarUpdateRequested.
        var step = new InputQuantityStep();
        var context = new PioneerEntryStepContext(PayloadWithQuantity(null), dryRun: false, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.False(result.Success);
        Assert.Contains("Cancelled", result.Message);
        Assert.Contains("quantity prompt was cancelled", result.Message);
    }

    [Fact]
    public async Task BlankQuantityWithNoPromptWiredCancelsEvenInDryRun()
    {
        var step = new InputQuantityStep();
        var context = new PioneerEntryStepContext(PayloadWithQuantity("   "), dryRun: true, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.False(result.Success);
        Assert.Contains("Cancelled", result.Message);
    }

    [Fact]
    public async Task BlankQuantityPromptTitleUsesTheVaccineNameFromThePayload()
    {
        var step = new InputQuantityStep();
        string? capturedTitle = null;
        var context = new PioneerEntryStepContext(PayloadWithQuantity(null, "mNEXSPIKE"), dryRun: true, _ => { })
        {
            RequestTextPrompt = (title, message, allowSkip) =>
            {
                capturedTitle = title;
                return TextPromptResult.Cancelled;
            },
        };

        await step.ExecuteAsync(context);

        Assert.Equal("Quantity needed for mNEXSPIKE", capturedTitle);
    }

    [Fact]
    public async Task BlankQuantityPromptFallsBackToAGenericNameWhenThePayloadHasNone()
    {
        var step = new InputQuantityStep();
        string? capturedTitle = null;
        var context = new PioneerEntryStepContext(PayloadWithQuantity(null, ""), dryRun: true, _ => { })
        {
            RequestTextPrompt = (title, message, allowSkip) =>
            {
                capturedTitle = title;
                return TextPromptResult.Cancelled;
            },
        };

        await step.ExecuteAsync(context);

        Assert.Equal("Quantity needed for this vaccine", capturedTitle);
    }

    [Fact]
    public async Task BlankQuantityPromptNeverOffersSkip()
    {
        var step = new InputQuantityStep();
        var allowSkipSeen = true;
        var context = new PioneerEntryStepContext(PayloadWithQuantity(null), dryRun: true, _ => { })
        {
            RequestTextPrompt = (title, message, allowSkip) =>
            {
                allowSkipSeen = allowSkip;
                return TextPromptResult.Cancelled;
            },
        };

        await step.ExecuteAsync(context);

        Assert.False(allowSkipSeen);
    }

    [Fact]
    public async Task BlankQuantityCancelledAtThePromptNeverCallsSave()
    {
        var step = new InputQuantityStep();
        var saveCalled = false;
        var context = new PioneerEntryStepContext(PayloadWithQuantity(null), dryRun: true, _ => { })
        {
            RequestTextPrompt = (title, message, allowSkip) => TextPromptResult.Cancelled,
            SaveQuantityAsync = value => { saveCalled = true; return Task.FromResult(true); },
        };

        var result = await step.ExecuteAsync(context);

        Assert.False(result.Success);
        Assert.False(saveCalled);
    }

    [Fact]
    public async Task BlankQuantityContinuedAtThePromptTypesAndSavesTheEnteredValue()
    {
        var step = new InputQuantityStep();
        string? savedValue = null;
        var log = new List<string>();
        var context = new PioneerEntryStepContext(PayloadWithQuantity(null), dryRun: true, log.Add)
        {
            RequestTextPrompt = (title, message, allowSkip) => TextPromptResult.Continued("0.5 mL"),
            SaveQuantityAsync = value => { savedValue = value; return Task.FromResult(true); },
        };

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.True(result.DryRun);
        Assert.Contains("0.5 mL", result.Message); // the dry-run description now uses the prompted value
        Assert.Equal("0.5 mL", savedValue);
        Assert.Contains(log, line => line.Contains("Saved quantity"));
    }

    [Fact]
    public async Task BlankQuantityContinuedWithAFailedSaveStillSucceedsAndLogsIt()
    {
        // Will's brief, verbatim: "a failed save must not abort the entry."
        var step = new InputQuantityStep();
        var log = new List<string>();
        var context = new PioneerEntryStepContext(PayloadWithQuantity(null), dryRun: true, log.Add)
        {
            RequestTextPrompt = (title, message, allowSkip) => TextPromptResult.Continued("0.5 mL"),
            SaveQuantityAsync = value => Task.FromResult(false),
        };

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.Contains(log, line => line.Contains("Couldn't save quantity") && line.Contains("continuing"));
    }

    [Fact]
    public async Task BlankQuantityContinuedWithASaveThatThrowsStillSucceedsAndLogsIt()
    {
        var step = new InputQuantityStep();
        var log = new List<string>();
        var context = new PioneerEntryStepContext(PayloadWithQuantity(null), dryRun: true, log.Add)
        {
            RequestTextPrompt = (title, message, allowSkip) => TextPromptResult.Continued("0.5 mL"),
            SaveQuantityAsync = value => throw new System.InvalidOperationException("network down"),
        };

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.Contains(log, line => line.Contains("network down") && line.Contains("continuing"));
    }

    [Fact]
    public async Task DryRunDescribesTheQuantityVerbatim()
    {
        var step = new InputQuantityStep();
        var context = new PioneerEntryStepContext(PayloadWithQuantity("0.5 mL"), dryRun: true, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.True(result.DryRun);
        Assert.Contains("0.5 mL", result.Message);
        Assert.Contains(InputQuantityStep.QuantityAutomationId, result.Message);
    }

    [Fact]
    public async Task DryRunDescribesANonNumericQuantityStringWithoutCrashing()
    {
        // The whole point of the reviewer fix: a real-world Pioneer
        // quantity value like this must not be parsed/rejected as a number.
        var step = new InputQuantityStep();
        var context = new PioneerEntryStepContext(PayloadWithQuantity("1 dose IM x1"), dryRun: true, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.Contains("1 dose IM x1", result.Message);
    }

    [Fact]
    public async Task LiveModeFailsWithNoAttachedWindowWhenAQuantityIsSet()
    {
        var step = new InputQuantityStep();
        var context = new PioneerEntryStepContext(PayloadWithQuantity("0.5 mL"), dryRun: false, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.False(result.Success);
        Assert.Contains("No PioneerRx window attached", result.Message);
    }
}
