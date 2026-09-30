using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-T65 (2026-09-29): FaxRunScheduler no longer owns a daily-run timer or
/// "Run now" — sending is a direct, explicit user action now (R4,
/// 2026-09-29: ViewModels/FaxSendViewModel.cs's SendAsync, which calls
/// FaxRunOrchestrator.RunAsync directly once Will presses Send in
/// Views/FaxSendWindow.xaml; that method's "already in progress" behavior
/// is covered by
/// FaxRunOrchestratorTests.RunsAreSerializedASecondConcurrentRunIsSkipped).
/// All that's left here is the background receipt-poll timer. FaxRunScheduler
/// owns a DispatcherTimer, so this test runs on a pumped STA thread via
/// StaTestRunner — same convention as
/// StartupSignInCoordinatorTests/RelayCommandRequeryTests (see
/// StaTestRunner.cs's own doc comment for why a plain xunit MTA thread
/// isn't enough for anything Dispatcher-adjacent).
/// </summary>
public class FaxRunSchedulerTests : IDisposable
{
    private readonly string _tempDir;
    private readonly string _faxRootDir;

    public FaxRunSchedulerTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "vaccine-assist-tests", Guid.NewGuid().ToString("n"));
        _faxRootDir = Path.Combine(_tempDir, "fax");
        Directory.CreateDirectory(_tempDir);
    }

    public void Dispose()
    {
        try { Directory.Delete(_tempDir, recursive: true); } catch { /* best-effort */ }
    }

    [Fact]
    public void ReceiptPollTimerPeriodicallyPollsOutstandingLedgerEntries()
    {
        StaTestRunner.RunStaAsync(async () =>
        {
            var reportImporter = new ReportImporter();
            var faxClient = new FakeFaxClient();
            var faxLedger = new FaxLedger(Path.Combine(_tempDir, "ledger.json"));
            faxLedger.Save(new List<FaxLedgerEntry>
            {
                // V-T65 R5: QueuedAtUtc must be "now", not the default
                // 0001-01-01 — FaxPollSchedule.HasExpired would otherwise
                // treat this entry as already 2h+ overdue and mark it
                // Unknown before ever checking its real status.
                new() { FaxId = "fax-1", Status = FaxLedgerStatus.InProcess, QueuedAtUtc = DateTime.UtcNow },
            });
            faxClient.StatusResults["fax-1"] = new FaxStatusResult(true, FaxSendStatus.Sent, null, null);

            var fileLedger = new FaxFileLedger(Path.Combine(_tempDir, "sent-files.json"));
            var orchestrator = new FaxRunOrchestrator(
                reportImporter, new VaccineRecordPdfBuilder(),
                faxClient, faxLedger, _faxRootDir, fileLedger);

            // Short injectable interval — production's real cadence is 15
            // seconds (see FaxRunScheduler's single-arg constructor).
            var scheduler = new FaxRunScheduler(orchestrator, TimeSpan.FromMilliseconds(20));

            try
            {
                scheduler.Start();

                var waited = TimeSpan.Zero;
                var pollInterval = TimeSpan.FromMilliseconds(10);
                while (faxClient.StatusChecks.Count == 0)
                {
                    if (waited > TimeSpan.FromSeconds(5))
                    {
                        throw new TimeoutException("Receipt-poll timer never ticked.");
                    }
                    await Task.Delay(pollInterval);
                    waited += pollInterval;
                }
            }
            finally
            {
                scheduler.Dispose();
            }

            Assert.Contains("fax-1", faxClient.StatusChecks);
            var reloaded = faxLedger.Load();
            Assert.Equal(FaxLedgerStatus.Sent, reloaded.Single().Status);
        });
    }
}
