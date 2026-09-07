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
/// SendF3AndDismissPreEntryDialogsStep (NEW, 2026-09-07; polling algorithm
/// REWRITTEN in the same day's reviewer request-changes round) — the
/// Rx-Profile-to-Add-New-Rx transition (F3, then ESC through the
/// "Priority"/"Scan Hard Copy" dialogs). Covers the PURE parts (dry run
/// description, the "no attached window" guard clause,
/// PreEntryDialogTitles.Matches' title-matching logic, AND — the reviewer's
/// explicit ask — DismissPendingDialogsAsync's order-agnostic/
/// sequential-appearance polling algorithm via fake delegates) — the real
/// FlaUI/UIA calls (sending F3, scanning the desktop for a dialog window,
/// re-attaching to "Add New Rx") can only be proven against a real
/// PioneerRx install on Windows, same posture as every other live branch
/// in this sequence (FocusPioneerWindowStep, QuickSearchFieldEntry, etc.).
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
    public void MatchesIsContainsCaseInsensitive(string windowTitle, string dialogTitleSubstring, bool expected)
    {
        Assert.Equal(expected, PreEntryDialogTitles.Matches(windowTitle, dialogTitleSubstring));
    }

    [Fact]
    public void AllListsBothKnownDialogTitles()
    {
        Assert.Equal(new[] { PreEntryDialogTitles.Priority, PreEntryDialogTitles.ScanHardCopy }, PreEntryDialogTitles.All);
    }

    // --- DismissPendingDialogsAsync: the reviewer's explicit ask for
    // either-order + sequential-appearance coverage of the polling
    // algorithm itself, via fake delegates (no real UIA/wall-clock waits —
    // see the class doc comment). NoOpWait never actually delays, so these
    // run instantly regardless of maxEmptyTicks.

    private static Task NoOpWait() => Task.CompletedTask;

    [Fact]
    public async Task DismissesBothDialogsWhenBothAreShowingImmediately_OrderDoesNotMatter()
    {
        var showing = new HashSet<string>(new[] { "Priority", "Scan Hard Copy" });
        var dismissed = new List<string>();
        bool TryDismissIfShowing(string title)
        {
            if (!showing.Contains(title)) return false;
            showing.Remove(title);
            dismissed.Add(title);
            return true;
        }

        var pending = await SendF3AndDismissPreEntryDialogsStep.DismissPendingDialogsAsync(
            new[] { "Priority", "Scan Hard Copy" }, maxEmptyTicks: 5, TryDismissIfShowing, NoOpWait);

        Assert.Empty(pending);
        Assert.Equal(2, dismissed.Count);
        Assert.Contains("Priority", dismissed);
        Assert.Contains("Scan Hard Copy", dismissed);
    }

    [Fact]
    public async Task DismissesScanHardCopyFirstWhenItAppearsBeforePriority()
    {
        // "Either order" — Scan Hard Copy showing, Priority not (yet).
        var showing = new HashSet<string> { "Scan Hard Copy" };
        bool TryDismissIfShowing(string title)
        {
            if (!showing.Contains(title)) return false;
            showing.Remove(title);
            return true;
        }

        var pending = await SendF3AndDismissPreEntryDialogsStep.DismissPendingDialogsAsync(
            new[] { "Priority", "Scan Hard Copy" }, maxEmptyTicks: 3, TryDismissIfShowing, NoOpWait);

        // Priority never appeared in this run — left over, exactly as a
        // machine with it configured off would look.
        Assert.Equal(new[] { "Priority" }, pending);
    }

    [Fact]
    public async Task SequentialDialogsDismissesBothEvenWhenSecondOnlyAppearsAfterFirstIsDismissed()
    {
        // The modal/sequential case the whole rewrite targets: "Scan Hard
        // Copy" isn't showing AT ALL until "Priority" has been dismissed.
        var priorityShowing = true;
        var scanHardCopyAppearedYet = false;
        var dismissed = new List<string>();

        bool TryDismissIfShowing(string title)
        {
            if (title == "Priority" && priorityShowing)
            {
                priorityShowing = false;
                scanHardCopyAppearedYet = true; // dismissing Priority reveals the next dialog
                dismissed.Add(title);
                return true;
            }
            if (title == "Scan Hard Copy" && scanHardCopyAppearedYet)
            {
                scanHardCopyAppearedYet = false;
                dismissed.Add(title);
                return true;
            }
            return false;
        }

        var pending = await SendF3AndDismissPreEntryDialogsStep.DismissPendingDialogsAsync(
            new[] { "Priority", "Scan Hard Copy" }, maxEmptyTicks: 3, TryDismissIfShowing, NoOpWait);

        Assert.Empty(pending);
        Assert.Equal(new[] { "Priority", "Scan Hard Copy" }, dismissed);
    }

    [Fact]
    public async Task SequentialDialogsInTheOppositeOrderAlsoDismissesBoth()
    {
        // Same sequential case, but "Priority" is the one that only
        // appears after "Scan Hard Copy" is dismissed — proves the
        // algorithm doesn't hardcode which one comes first.
        var scanHardCopyShowing = true;
        var priorityAppearedYet = false;
        var dismissed = new List<string>();

        bool TryDismissIfShowing(string title)
        {
            if (title == "Scan Hard Copy" && scanHardCopyShowing)
            {
                scanHardCopyShowing = false;
                priorityAppearedYet = true;
                dismissed.Add(title);
                return true;
            }
            if (title == "Priority" && priorityAppearedYet)
            {
                priorityAppearedYet = false;
                dismissed.Add(title);
                return true;
            }
            return false;
        }

        var pending = await SendF3AndDismissPreEntryDialogsStep.DismissPendingDialogsAsync(
            new[] { "Priority", "Scan Hard Copy" }, maxEmptyTicks: 3, TryDismissIfShowing, NoOpWait);

        Assert.Empty(pending);
        Assert.Equal(new[] { "Scan Hard Copy", "Priority" }, dismissed);
    }

    [Fact]
    public async Task NeitherDialogAppearingLeavesBothPendingAfterMaxEmptyTicksAndCallsWaitTickEachTime()
    {
        var waitTickCallCount = 0;
        Task CountingWait() { waitTickCallCount++; return Task.CompletedTask; }

        var pending = await SendF3AndDismissPreEntryDialogsStep.DismissPendingDialogsAsync(
            new[] { "Priority", "Scan Hard Copy" }, maxEmptyTicks: 2, _ => false, CountingWait);

        // OrderBy first — pending is backed by a HashSet, whose enumeration
        // order isn't guaranteed, so a raw sequence-equality assert here
        // would be order-flaky.
        Assert.Equal(new[] { "Priority", "Scan Hard Copy" }.OrderBy(t => t), pending.OrderBy(t => t));
        Assert.Equal(3, waitTickCallCount); // maxEmptyTicks (2) + 1, per the loop's own <= bound
    }

    [Fact]
    public async Task RespectsAnAlreadyCancelledToken()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(() =>
            SendF3AndDismissPreEntryDialogsStep.DismissPendingDialogsAsync(
                new[] { "Priority" }, maxEmptyTicks: 5, _ => false, NoOpWait, cts.Token));
    }
}
