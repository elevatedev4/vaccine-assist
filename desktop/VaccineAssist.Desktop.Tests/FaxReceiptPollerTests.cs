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
}
