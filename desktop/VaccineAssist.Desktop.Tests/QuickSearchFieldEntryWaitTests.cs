using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// QuickSearchFieldEntry.WaitForFieldCoreAsync / DescribeException — the
/// 2026-09-11 fix for the "Select prescriber" failure (owner's log, build
/// ef5058f): the prescriber and drug/NDC quick-search fields got the same
/// "poll for the field before giving up" hardening
/// InputLotAndExpirationStep already got on 2026-09-10, plus a fix so a
/// blank/empty exception message no longer leaves the failure line ending
/// right after the colon with nothing diagnosable after it.
///
/// WaitForFieldCoreAsync is the PURE part of WaitForFieldAsync (generic,
/// not AutomationElement-specific — same "pure logic split out as a
/// generic method for testability" pattern as
/// SendF3AndDismissPreEntryDialogsStep.WaitForAsync, which this reuses
/// internally) — fake finder/waitTick delegates prove the polling and
/// success-only logging behavior without a live PioneerRx/UIA session.
/// The AutomationElement-specific wrapper (WaitForFieldAsync itself:
/// re-focus + FindFirstDescendant) is FlaUI/UIA-dependent and can only be
/// proven against a real PioneerRx install on Windows, same posture as
/// every other live branch in this sequence.
///
/// DescribeException is plain Exception-in/string-out logic with no UIA
/// dependency at all, so it's tested directly.
/// </summary>
public class QuickSearchFieldEntryWaitTests
{
    private static Task NoOpWait() => Task.CompletedTask;

    // --- WaitForFieldCoreAsync ---

    [Fact]
    public async Task ReturnsTrueImmediatelyWhenTheFieldIsAlreadyThere()
    {
        var logMessages = new List<string>();

        var found = await QuickSearchFieldEntry.WaitForFieldCoreAsync<string>(
            tryFind: () => "field-element",
            automationId: "uxPrescriberQuickSearch",
            maxEmptyTicks: 5,
            waitTick: NoOpWait,
            log: logMessages.Add);

        Assert.True(found);
        var message = Assert.Single(logMessages);
        Assert.Contains("uxPrescriberQuickSearch", message);
        Assert.Contains("waited", message);
    }

    [Fact]
    public async Task ReturnsTrueAndReportsElapsedAfterTheFieldAppearsOnALaterTick()
    {
        var attempt = 0;
        string? TryFind()
        {
            attempt++;
            return attempt >= 3 ? "field-element" : null; // null twice, then found
        }

        var logMessages = new List<string>();

        var found = await QuickSearchFieldEntry.WaitForFieldCoreAsync<string>(
            TryFind, "uxPrescribedItemQuickSearch", maxEmptyTicks: 5, NoOpWait, logMessages.Add);

        Assert.True(found);
        Assert.Equal(3, attempt);
        var message = Assert.Single(logMessages);
        Assert.Contains("uxPrescribedItemQuickSearch", message);
    }

    [Fact]
    public async Task ReturnsFalseAndNeverLogsWhenTheFieldNeverAppears()
    {
        var waitTickCallCount = 0;
        Task CountingWait() { waitTickCallCount++; return Task.CompletedTask; }
        var logMessages = new List<string>();

        var found = await QuickSearchFieldEntry.WaitForFieldCoreAsync<string>(
            tryFind: () => null,
            automationId: "uxPrescriberQuickSearch",
            maxEmptyTicks: 3,
            waitTick: CountingWait,
            log: logMessages.Add);

        Assert.False(found);
        Assert.Empty(logMessages); // no "waited Nms" log on a timeout — caller reports the failure itself
        Assert.Equal(3, waitTickCallCount); // exactly maxEmptyTicks, same shape as WaitForAsync's own tests
    }

    [Fact]
    public async Task WorksWithoutALogSinkAtAll()
    {
        // context.Log is a plain Action<string>, but the `log` parameter
        // here is optional (null default) — must not throw when omitted.
        var found = await QuickSearchFieldEntry.WaitForFieldCoreAsync<string>(
            tryFind: () => "field-element", automationId: "uxLotNumber", maxEmptyTicks: 5, waitTick: NoOpWait, log: null);

        Assert.True(found);
    }

    [Fact]
    public async Task SucceedsOnceEnabledAfterBeingFoundButDisabledAndLogsThatOnlyOnce()
    {
        // V-..., 2026-09-11 (owner's log, 17:15, build 7ab6500): the field
        // EXISTED 416ms after F3 but ElementNotEnabledException was thrown
        // trying to focus/type into it — PioneerRx hadn't finished
        // initializing the Add New Rx form yet. WaitForFieldAsync's own
        // TryFind local function (FlaUI/UIA-dependent, not directly
        // testable here — see this class's own doc comment) now treats
        // "found but disabled" the same way this fake tryFind does: log
        // the "present but disabled" line exactly once, then keep
        // returning null (not found) until the fake flips to enabled.
        const int disabledTicks = 3;
        var attempt = 0;
        var loggedDisabledOnce = false;
        var loggedDisabledCount = 0;
        var logMessages = new List<string>();

        void Log(string message)
        {
            logMessages.Add(message);
            if (message.Contains("present but disabled")) loggedDisabledCount++;
        }

        string? TryFind()
        {
            attempt++;
            var isEnabled = attempt > disabledTicks;
            if (!isEnabled)
            {
                if (!loggedDisabledOnce)
                {
                    loggedDisabledOnce = true;
                    Log("'uxPrescriberQuickSearch' present but disabled — waiting");
                }
                return null;
            }
            return "field-element";
        }

        var found = await QuickSearchFieldEntry.WaitForFieldCoreAsync<string>(
            TryFind, "uxPrescriberQuickSearch", maxEmptyTicks: 10, NoOpWait, Log);

        Assert.True(found);
        Assert.Equal(disabledTicks + 1, attempt);
        Assert.Equal(1, loggedDisabledCount);
        Assert.Contains(logMessages, m => m.Contains("present but disabled"));
        Assert.Contains(logMessages, m => m.Contains("waited")); // the success log WaitForFieldCoreAsync itself adds
    }

    [Fact]
    public async Task RespectsAnAlreadyCancelledToken()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(() =>
            QuickSearchFieldEntry.WaitForFieldCoreAsync<string>(
                () => null, "uxPrescriberQuickSearch", maxEmptyTicks: 5, NoOpWait, log: null, cts.Token));
    }

    // --- DescribeException ---

    [Fact]
    public void DescribeExceptionUsesTheTypeNameAndFirstLineOfMessage()
    {
        var ex = new InvalidOperationException("PioneerRx didn't respond");

        var described = QuickSearchFieldEntry.DescribeException(ex);

        Assert.Equal("InvalidOperationException: PioneerRx didn't respond", described);
    }

    [Fact]
    public void DescribeExceptionNeverComesBackEmptyWhenMessageIsBlank()
    {
        // The owner's log line ended right after the colon with nothing
        // after it — this is the exact failure mode being fixed.
        var ex = new InvalidOperationException("");

        var described = QuickSearchFieldEntry.DescribeException(ex);

        Assert.Equal("InvalidOperationException: <empty message>", described);
    }

    [Fact]
    public void DescribeExceptionUsesOnlyTheFirstNonBlankLineOfAMultiLineMessage()
    {
        var ex = new InvalidOperationException("\n   \nActual first useful line\nsecond line");

        var described = QuickSearchFieldEntry.DescribeException(ex);

        Assert.Equal("InvalidOperationException: Actual first useful line", described);
    }

    [Fact]
    public void DescribeExceptionAppendsHResultInHexForAComException()
    {
        var ex = new COMException("Operation timed out.", unchecked((int)0x80131505));

        var described = QuickSearchFieldEntry.DescribeException(ex);

        Assert.Equal("COMException: Operation timed out. (HResult 0x80131505)", described);
    }

    [Fact]
    public void DescribeExceptionOmitsHResultSuffixForNonComExceptions()
    {
        var ex = new InvalidOperationException("busy");

        var described = QuickSearchFieldEntry.DescribeException(ex);

        Assert.DoesNotContain("HResult", described);
    }
}
