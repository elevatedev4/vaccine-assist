using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>V-T65 R5 (Will, verbatim, 2026-09-29): "it still shows status
/// 'InProcess' in the app. Need to make sure this stuff updates." Exercises
/// FaxReceiptPoller's status mapping and FaxPollSchedule gating together
/// against a real (temp-file) FaxLedger + FakeFaxClient — no WPF/timer
/// involved (FaxRunSchedulerTests covers the DispatcherTimer wiring
/// separately).</summary>
public class FaxReceiptPollerTests : IDisposable
{
    private readonly string _ledgerPath;

    public FaxReceiptPollerTests()
    {
        _ledgerPath = Path.Combine(Path.GetTempPath(), "vaccine-assist-tests", Guid.NewGuid().ToString("n") + ".json");
    }

    public void Dispose()
    {
        try { File.Delete(_ledgerPath); } catch { /* best-effort */ }
    }

    private static FaxLedgerEntry MakeEntry(string faxId, DateTime queuedAtUtc, DateTime? lastCheckedAtUtc = null) => new()
    {
        FaxId = faxId,
        Status = FaxLedgerStatus.InProcess,
        QueuedAtUtc = queuedAtUtc,
        LastCheckedAtUtc = lastCheckedAtUtc,
    };

    [Fact]
    public async Task SentStatusFromTheVendorMarksTheLedgerEntrySent()
    {
        var ledger = new FaxLedger(_ledgerPath);
        ledger.Save(new List<FaxLedgerEntry> { MakeEntry("fax-1", DateTime.UtcNow) });
        var faxClient = new FakeFaxClient();
        faxClient.StatusResults["fax-1"] = new FaxStatusResult(true, FaxSendStatus.Sent, null, null);

        await new FaxReceiptPoller(ledger, faxClient).PollAsync();

        Assert.Equal(FaxLedgerStatus.Sent, ledger.Load().Single().Status);
    }

    [Fact]
    public async Task FailedStatusFromTheVendorCarriesTheFailureReasonText()
    {
        var ledger = new FaxLedger(_ledgerPath);
        ledger.Save(new List<FaxLedgerEntry> { MakeEntry("fax-1", DateTime.UtcNow) });
        var faxClient = new FakeFaxClient();
        faxClient.StatusResults["fax-1"] = new FaxStatusResult(true, FaxSendStatus.Failed, "busy — no answer", null);

        await new FaxReceiptPoller(ledger, faxClient).PollAsync();

        var entry = ledger.Load().Single();
        Assert.Equal(FaxLedgerStatus.Failed, entry.Status);
        Assert.Equal("busy — no answer", entry.Error);
    }

    [Fact]
    public async Task StillInProcessFromTheVendorStaysInProcess()
    {
        var ledger = new FaxLedger(_ledgerPath);
        ledger.Save(new List<FaxLedgerEntry> { MakeEntry("fax-1", DateTime.UtcNow) });
        var faxClient = new FakeFaxClient();
        faxClient.StatusResults["fax-1"] = new FaxStatusResult(true, FaxSendStatus.InProcess, null, null);

        await new FaxReceiptPoller(ledger, faxClient).PollAsync();

        Assert.Equal(FaxLedgerStatus.InProcess, ledger.Load().Single().Status);
    }

    [Fact]
    public async Task AnEntryNotYetDueForAnotherCheckIsSkippedWithNoVendorCall()
    {
        var ledger = new FaxLedger(_ledgerPath);
        var now = DateTime.UtcNow;
        // Checked 5 seconds ago, under the 5-minute-old threshold -> next
        // check isn't due for another 10s (15s fast interval).
        ledger.Save(new List<FaxLedgerEntry> { MakeEntry("fax-1", now, lastCheckedAtUtc: now.AddSeconds(-5)) });
        var faxClient = new FakeFaxClient();
        faxClient.StatusResults["fax-1"] = new FaxStatusResult(true, FaxSendStatus.Sent, null, null);

        await new FaxReceiptPoller(ledger, faxClient).PollAsync();

        Assert.Empty(faxClient.StatusChecks);
        Assert.Equal(FaxLedgerStatus.InProcess, ledger.Load().Single().Status);
    }

    [Fact]
    public async Task AnEntryOlderThanTwoHoursIsMarkedUnknownWithoutCallingTheVendorAgain()
    {
        var ledger = new FaxLedger(_ledgerPath);
        var queuedAtUtc = DateTime.UtcNow.AddHours(-3);
        ledger.Save(new List<FaxLedgerEntry> { MakeEntry("fax-1", queuedAtUtc, lastCheckedAtUtc: queuedAtUtc.AddMinutes(1)) });
        var faxClient = new FakeFaxClient();

        var transitioned = await new FaxReceiptPoller(ledger, faxClient).PollAsync();

        Assert.Equal(1, transitioned);
        Assert.Empty(faxClient.StatusChecks); // gave up — never even asked Notifyre
        var entry = ledger.Load().Single();
        Assert.Equal(FaxLedgerStatus.Unknown, entry.Status);
        Assert.Contains("Unknown", entry.Error);

        // And it stays out of "pending" on the next pass — no further checks.
        await new FaxReceiptPoller(ledger, faxClient).PollAsync();
        Assert.Empty(faxClient.StatusChecks);
    }

    [Fact]
    public async Task ATerminalOrGiveUpTransitionSavesButAnUneventfulPassDoesNotRewriteTheLedgerFile()
    {
        var ledger = new FaxLedger(_ledgerPath);
        var now = DateTime.UtcNow;
        ledger.Save(new List<FaxLedgerEntry> { MakeEntry("fax-1", now, lastCheckedAtUtc: now.AddSeconds(-1)) });
        var faxClient = new FakeFaxClient();

        var writeTimeBefore = File.GetLastWriteTimeUtc(_ledgerPath);
        await Task.Delay(20); // ensure a detectable timestamp delta if a write happens
        await new FaxReceiptPoller(ledger, faxClient).PollAsync(); // not due yet — no vendor call, no save

        Assert.Empty(faxClient.StatusChecks);
        Assert.Equal(writeTimeBefore, File.GetLastWriteTimeUtc(_ledgerPath));
    }

    // ---- V-T65 (Will, 2026-10-20): "It sent the fax successfully but didn't
    // change the status in the app." First poll (81 ms after submit) mapped
    // "not found yet" to Failed. ----

    private static FaxStatusResult NotFound() => new(
        false, FaxSendStatus.Failed, "Fax fax-1 wasn't found in Notifyre's sent faxes.", null, NotFound: true);

    [Fact]
    public async Task NotFoundInsideTheGraceWindowStaysInProcessAndIsNotFailed()
    {
        var ledger = new FaxLedger(_ledgerPath);
        ledger.Save(new List<FaxLedgerEntry> { MakeEntry("fax-1", DateTime.UtcNow.AddSeconds(-1)) });
        var faxClient = new FakeFaxClient();
        faxClient.StatusResults["fax-1"] = NotFound();

        var transitioned = await new FaxReceiptPoller(ledger, faxClient).PollAsync();

        Assert.Equal(0, transitioned);
        var entry = ledger.Load().Single();
        Assert.Equal(FaxLedgerStatus.InProcess, entry.Status);
        Assert.Null(entry.Error);
        Assert.False(entry.NotFoundFailure);
    }

    [Fact]
    public async Task NotFoundAfterTheGraceWindowBecomesFailedWithTheExistingMessage()
    {
        var ledger = new FaxLedger(_ledgerPath);
        ledger.Save(new List<FaxLedgerEntry> { MakeEntry("fax-1", DateTime.UtcNow.AddMinutes(-6), lastCheckedAtUtc: DateTime.UtcNow.AddMinutes(-2)) });
        var faxClient = new FakeFaxClient();
        faxClient.StatusResults["fax-1"] = NotFound();

        var transitioned = await new FaxReceiptPoller(ledger, faxClient).PollAsync();

        Assert.Equal(1, transitioned);
        var entry = ledger.Load().Single();
        Assert.Equal(FaxLedgerStatus.Failed, entry.Status);
        Assert.Contains("wasn't found", entry.Error);
        Assert.True(entry.NotFoundFailure);
    }

    [Fact]
    public async Task ALaterSentOverridesANotFoundFailed()
    {
        var ledger = new FaxLedger(_ledgerPath);
        var failed = MakeEntry("fax-1", DateTime.UtcNow.AddMinutes(-7), lastCheckedAtUtc: DateTime.UtcNow.AddMinutes(-3));
        failed.Status = FaxLedgerStatus.Failed;
        failed.Error = "Fax fax-1 wasn't found in Notifyre's sent faxes.";
        failed.NotFoundFailure = true;
        ledger.Save(new List<FaxLedgerEntry> { failed });
        var faxClient = new FakeFaxClient();
        faxClient.StatusResults["fax-1"] = new FaxStatusResult(true, FaxSendStatus.Sent, null, null, "successful");

        await new FaxReceiptPoller(ledger, faxClient).PollAsync();

        var entry = ledger.Load().Single();
        Assert.Equal(FaxLedgerStatus.Sent, entry.Status);
        Assert.Null(entry.Error);
        Assert.False(entry.NotFoundFailure);
    }

    [Fact]
    public async Task ARealVendorReportedFailedIsFinalAndNeverRechecked()
    {
        var ledger = new FaxLedger(_ledgerPath);
        ledger.Save(new List<FaxLedgerEntry> { MakeEntry("fax-1", DateTime.UtcNow) });
        var faxClient = new FakeFaxClient();
        faxClient.StatusResults["fax-1"] = new FaxStatusResult(true, FaxSendStatus.Failed, "busy", null);
        await new FaxReceiptPoller(ledger, faxClient).PollAsync();

        faxClient.StatusChecks.Clear();
        faxClient.StatusResults["fax-1"] = new FaxStatusResult(true, FaxSendStatus.Sent, null, null);
        await new FaxReceiptPoller(ledger, faxClient).PollAsync();

        Assert.Empty(faxClient.StatusChecks);
        Assert.Equal(FaxLedgerStatus.Failed, ledger.Load().Single().Status);
    }

    [Theory]
    [InlineData(0, true)]
    [InlineData(299, true)]
    [InlineData(300, false)]
    [InlineData(3600, false)]
    public void NotFoundGraceWindowIsFiveMinutesSinceQueuing(int secondsSinceQueued, bool expectedInGrace)
    {
        var queued = new DateTime(2026, 10, 20, 16, 5, 47, DateTimeKind.Utc);
        Assert.Equal(expectedInGrace, FaxPollSchedule.IsWithinNotFoundGrace(queued, queued.AddSeconds(secondsSinceQueued)));
    }

    [Fact]
    public async Task ANotFoundFailedStillNotFoundAfterTwoHoursBecomesFinalAndNeverConfirmed()
    {
        var ledger = new FaxLedger(_ledgerPath);
        var entry = MakeEntry("fax-1", DateTime.UtcNow.AddHours(-3), lastCheckedAtUtc: DateTime.UtcNow.AddMinutes(-5));
        entry.Status = FaxLedgerStatus.Failed;
        entry.NotFoundFailure = true;
        ledger.Save(new List<FaxLedgerEntry> { entry });
        var faxClient = new FakeFaxClient();

        await new FaxReceiptPoller(ledger, faxClient).PollAsync();

        var saved = ledger.Load().Single();
        Assert.Equal(FaxLedgerStatus.Failed, saved.Status);
        Assert.False(saved.NotFoundFailure);
        Assert.True(saved.NeverConfirmed);
        Assert.Empty(faxClient.StatusChecks);
    }
}
