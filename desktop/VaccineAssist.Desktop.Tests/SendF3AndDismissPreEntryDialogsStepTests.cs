using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using VaccineAssist.Desktop.Uia;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// SendF3AndDismissPreEntryDialogsStep — the Rx-Profile-to-Add-New-Rx
/// transition (F3, then ESC through the "Priority"/"Scan Hard Copy"/
/// "Patient on Cycle Fill" dialogs). Covers the PURE parts (dry run
/// description, the "no attached window" guard clause,
/// PreEntryDialogTitles.Matches' title-matching logic, AND —
/// RunCombinedPreEntryLoopAsync's own polling algorithm, plus the shared
/// WaitForAsync primitive — via fake delegates) — the real FlaUI/UIA calls
/// (sending F3, scanning the desktop for a dialog window, re-attaching to
/// "Add New Rx") can only be proven against a real PioneerRx install on
/// Windows, same posture as every other live branch in this sequence
/// (FocusPioneerWindowStep, QuickSearchFieldEntry, etc.).
///
/// SPEED REWORK (V-..., 2026-09-10, Will's real app.log: this step took
/// 102s on a live run): the old three-phase sequence
/// (DismissPendingDialogsAsync + DismissAllStrayWindowsAsync + a
/// phase-specific WaitForAsync call) is replaced by ONE combined loop —
/// see RunCombinedPreEntryLoopAsync's own doc comment and the class's.
/// These tests replace the old per-phase pure-logic tests with coverage
/// of that single combined loop; WaitForAsync itself is unchanged (now
/// also reused by InputLotAndExpirationStep, via the new single-signal
/// overload below, for its own "poll for the lot field up to 15s" fix —
/// see that step's own doc comment) and keeps its existing two-signal
/// tests, plus new coverage for the single-signal overload itself.
/// </summary>
public class SendF3AndDismissPreEntryDialogsStepTests
{
    private static VaccineEntryPayload SamplePayload() =>
        new("mmr1", "LOT123", "01152027", "Left arm", Ndc: "00069-2025-10", PhysicianAlternateId: "ALTPRIMARY");

    [Fact]
    public async Task DryRunDescribesF3AndBothDialogsWithoutTouchingPioneerRx()
    {
        var step = new SendF3AndDismissPreEntryDialogsStep();
        var context = new PioneerEntryStepContext(SamplePayload(), dryRun: true, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.True(result.Success);
        Assert.True(result.DryRun);
        Assert.Contains("F3", result.Message);
        Assert.Contains("Priority", result.Message);
        Assert.Contains("Scan Hard Copy", result.Message);
        Assert.Contains("Patient on Cycle Fill", result.Message); // MSG893 hotfix: third recognized dialog
        Assert.Null(context.AttachedWindow); // dry run never attaches
    }

    [Fact]
    public async Task LiveModeFailsWithNoAttachedWindow()
    {
        var step = new SendF3AndDismissPreEntryDialogsStep();
        var context = new PioneerEntryStepContext(SamplePayload(), dryRun: false, _ => { });

        var result = await step.ExecuteAsync(context);

        Assert.False(result.Success);
        Assert.Contains("No PioneerRx window attached", result.Message);
    }

    [Theory]
    [InlineData("Priority", "Priority", true)]
    [InlineData("priority", "Priority", true)]
    [InlineData("Select Priority", "Priority", true)]
    [InlineData("Scan Hard Copy", "Scan Hard Copy", true)]
    [InlineData("scan hard copy order", "Scan Hard Copy", true)]
    [InlineData("Add New Rx", "Priority", false)]
    [InlineData("Rx Profile", "Scan Hard Copy", false)]
    [InlineData("Patient on Cycle Fill", "Patient on Cycle Fill", true)]
    [InlineData("patient on cycle fill", "Patient on Cycle Fill", true)]
    [InlineData("Patient is on Cycle Fill", "Patient on Cycle Fill", false)] // Contains, not fuzzy — see class doc comment
    public void MatchesIsContainsCaseInsensitive(string windowTitle, string dialogTitleSubstring, bool expected)
    {
        Assert.Equal(expected, PreEntryDialogTitles.Matches(windowTitle, dialogTitleSubstring));
    }

    [Fact]
    public void AllListsEveryKnownDialogTitleIncludingCycleFill()
    {
        Assert.Equal(
            new[] { PreEntryDialogTitles.Priority, PreEntryDialogTitles.ScanHardCopy, PreEntryDialogTitles.PatientOnCycleFill },
            PreEntryDialogTitles.All);
    }

    // --- MSG893 item 2 rework: PreEntryDialogTitles.MatchesWithAliases ---

    [Theory]
    [InlineData("Priority", "Priority", true)]
    [InlineData("Patient on Cycle Fill", "Patient on Cycle Fill", true)]
    [InlineData("Cycle Fill Warning", "Patient on Cycle Fill", true)] // the new alias
    [InlineData("cycle fill", "Patient on Cycle Fill", true)]
    [InlineData("Scan Hard Copy", "Priority", false)]
    [InlineData("Cycle Fill Warning", "Priority", false)] // alias is scoped to PatientOnCycleFill only
    public void MatchesWithAliasesAcceptsTheShorterCycleFillAliasOnlyForThatDialog(string windowTitle, string dialogTitleSubstring, bool expected)
    {
        Assert.Equal(expected, PreEntryDialogTitles.MatchesWithAliases(windowTitle, dialogTitleSubstring));
    }

    // --- RunCombinedPreEntryLoopAsync: the combined dismiss+wait loop ---

    private static Task NoOpWait() => Task.CompletedTask;

    [Fact]
    public async Task ReturnsImmediatelyReadyWhenAddNewRxIsAlreadyThereAndNeverTriesToDismissAnything()
    {
        var dismissAttempts = 0;

        var result = await SendF3AndDismissPreEntryDialogsStep.RunCombinedPreEntryLoopAsync(
            isAddNewRxReady: () => true,
            tryDismissNextPending: () => { dismissAttempts++; return null; },
            maxEmptyTicks: 5, NoOpWait);

        Assert.True(result.AddNewRxReady);
        Assert.Empty(result.DismissedTitles);
        Assert.Equal(0, dismissAttempts); // isAddNewRxReady short-circuits before ever trying to dismiss
    }

    [Fact]
    public async Task DismissesOneDialogThenBecomesReadyOnTheVeryNextCheck()
    {
        var priorityShowing = true;
        var readyOnceDismissed = false;

        bool IsReady() => readyOnceDismissed;
        string? TryDismiss()
        {
            if (!priorityShowing) return null;
            priorityShowing = false;
            readyOnceDismissed = true; // dismissing it reveals Add New Rx immediately
            return "Priority";
        }

        var result = await SendF3AndDismissPreEntryDialogsStep.RunCombinedPreEntryLoopAsync(
            IsReady, TryDismiss, maxEmptyTicks: 5, NoOpWait);

        Assert.True(result.AddNewRxReady);
        Assert.Equal(new[] { "Priority" }, result.DismissedTitles);
    }

    [Fact]
    public async Task DismissesMultipleWindowsInSequenceBeforeBecomingReady()
    {
        // Sequential/modal case: "Scan Hard Copy" only shows up after
        // "Priority" is dismissed, and Add New Rx only becomes ready after
        // BOTH are gone — same shape as the old three-phase test's
        // sequential-appearance coverage, now against the single loop.
        var pending = new Queue<string>(new[] { "Priority", "Scan Hard Copy" });
        var ready = false;

        bool IsReady() => ready;
        string? TryDismiss()
        {
            if (pending.Count == 0) return null;
            var title = pending.Dequeue();
            if (pending.Count == 0) ready = true;
            return title;
        }

        var result = await SendF3AndDismissPreEntryDialogsStep.RunCombinedPreEntryLoopAsync(
            IsReady, TryDismiss, maxEmptyTicks: 5, NoOpWait);

        Assert.True(result.AddNewRxReady);
        Assert.Equal(new[] { "Priority", "Scan Hard Copy" }, result.DismissedTitles);
    }

    [Fact]
    public async Task RescansImmediatelyAfterADismissalWithoutCallingWaitTick()
    {
        var waitTickCallCount = 0;
        Task CountingWait() { waitTickCallCount++; return Task.CompletedTask; }

        var dismissedOnce = false;
        bool IsReady() => dismissedOnce; // ready right after the one dismissal
        string? TryDismiss()
        {
            if (dismissedOnce) return null;
            dismissedOnce = true;
            return "Priority";
        }

        await SendF3AndDismissPreEntryDialogsStep.RunCombinedPreEntryLoopAsync(
            IsReady, TryDismiss, maxEmptyTicks: 5, CountingWait);

        Assert.Equal(0, waitTickCallCount); // dismissal -> immediate rescan -> ready, no wait needed at all
    }

    [Fact]
    public async Task NeverBecomingReadyWithNothingToDismissTimesOutAfterMaxEmptyTicks()
    {
        var waitTickCallCount = 0;
        Task CountingWait() { waitTickCallCount++; return Task.CompletedTask; }

        var result = await SendF3AndDismissPreEntryDialogsStep.RunCombinedPreEntryLoopAsync(
            isAddNewRxReady: () => false,
            tryDismissNextPending: () => null,
            maxEmptyTicks: 3, CountingWait);

        Assert.False(result.AddNewRxReady);
        Assert.Empty(result.DismissedTitles);
        Assert.Equal(3, waitTickCallCount); // exactly maxEmptyTicks — the loop's own >= check fires on
                                             // the (maxEmptyTicks+1)th pass BEFORE that pass's wait runs
    }

    [Fact]
    public async Task RespectsAnAlreadyCancelledToken()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(() =>
            SendF3AndDismissPreEntryDialogsStep.RunCombinedPreEntryLoopAsync(
                () => false, () => null, maxEmptyTicks: 5, NoOpWait, cts.Token));
    }

    // --- WaitForAsync (two-signal "either" polling primitive) ---

    [Fact]
    public async Task WaitForAsyncReturnsImmediatelyWhenThePrimarySignalAlreadyMatches()
    {
        var fallbackCalled = false;
        var result = await SendF3AndDismissPreEntryDialogsStep.WaitForAsync<string>(
            () => "found-by-title",
            () => { fallbackCalled = true; return null; },
            maxEmptyTicks: 3, NoOpWait);

        Assert.Equal("found-by-title", result);
        Assert.False(fallbackCalled); // ?? short-circuits — the fallback signal is never even checked
    }

    [Fact]
    public async Task WaitForAsyncFallsBackToTheSecondSignalWhenThePrimaryNeverMatches()
    {
        var result = await SendF3AndDismissPreEntryDialogsStep.WaitForAsync<string>(
            () => null,
            () => "found-by-field",
            maxEmptyTicks: 3, NoOpWait);

        Assert.Equal("found-by-field", result);
    }

    [Fact]
    public async Task WaitForAsyncFindsAMatchOnALaterTickAfterInitialEmptyTicks()
    {
        var attempt = 0;
        string? TryPrimary()
        {
            attempt++;
            return attempt >= 3 ? "found-on-third-try" : null;
        }

        var result = await SendF3AndDismissPreEntryDialogsStep.WaitForAsync<string>(
            TryPrimary, () => null, maxEmptyTicks: 5, NoOpWait);

        Assert.Equal("found-on-third-try", result);
    }

    [Fact]
    public async Task WaitForAsyncReturnsNullWhenNeitherSignalEverMatches()
    {
        var waitTickCallCount = 0;
        Task CountingWait() { waitTickCallCount++; return Task.CompletedTask; }

        var result = await SendF3AndDismissPreEntryDialogsStep.WaitForAsync<string>(
            () => null, () => null, maxEmptyTicks: 2, CountingWait);

        Assert.Null(result);
        // V-..., 2026-09-10 REVIEWER FIX: this assertion previously said 3
        // ("maxEmptyTicks + 1") — empirically wrong for this loop's actual
        // shape (`if (tick >= maxEmptyTicks) return null;` checked BEFORE
        // the increment/wait, not a `while (tick <= maxEmptyTicks)` guard
        // the way the now-removed DismissPendingDialogsAsync used) —
        // verified with a standalone repro against the exact loop body.
        // Caught while adding SingleSignalOverloadReturnsNullAfterMaxEmptyTicks
        // below, which shares this same loop shape.
        Assert.Equal(2, waitTickCallCount); // exactly maxEmptyTicks
    }

    [Fact]
    public async Task WaitForAsyncRespectsAnAlreadyCancelledToken()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(() =>
            SendF3AndDismissPreEntryDialogsStep.WaitForAsync<string>(
                () => null, () => null, maxEmptyTicks: 5, NoOpWait, cts.Token));
    }

    // --- WaitForAsync's single-signal convenience overload (V-..., 2026-09-10
    // — added for InputLotAndExpirationStep's "wait for one field to show
    // up" use case; see InputLotAndExpirationStepFieldWaitTests.cs) ---

    [Fact]
    public async Task SingleSignalOverloadReturnsAsSoonAsTheSignalMatches()
    {
        var attempt = 0;
        string? TryFind()
        {
            attempt++;
            return attempt >= 2 ? "found" : null;
        }

        var result = await SendF3AndDismissPreEntryDialogsStep.WaitForAsync<string>(
            TryFind, maxEmptyTicks: 5, NoOpWait);

        Assert.Equal("found", result);
    }

    [Fact]
    public async Task SingleSignalOverloadReturnsNullAfterMaxEmptyTicks()
    {
        var waitTickCallCount = 0;
        Task CountingWait() { waitTickCallCount++; return Task.CompletedTask; }

        var result = await SendF3AndDismissPreEntryDialogsStep.WaitForAsync<string>(
            () => null, maxEmptyTicks: 2, CountingWait);

        Assert.Null(result);
        Assert.Equal(2, waitTickCallCount); // exactly maxEmptyTicks — see WaitForAsyncReturnsNullWhenNeitherSignalEverMatches's comment
    }
}
