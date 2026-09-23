using System;
using System.IO;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Fax;
using VaccineAssist.Desktop.Settings;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// FaxRunScheduler owns DispatcherTimers, so tests run on a pumped STA
/// thread via StaTestRunner — same convention as
/// StartupSignInCoordinatorTests/RelayCommandRequeryTests (see
/// StaTestRunner.cs's own doc comment for why a plain xunit MTA thread
/// isn't enough for anything Dispatcher-adjacent).
/// </summary>
public class FaxRunSchedulerTests : IDisposable
{
    private readonly string _tempDir;
    private readonly string _inputDir;
    private readonly string _faxRootDir;

    public FaxRunSchedulerTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "vaccine-assist-tests", Guid.NewGuid().ToString("n"));
        _inputDir = Path.Combine(_tempDir, "input");
        _faxRootDir = Path.Combine(_tempDir, "fax");
        Directory.CreateDirectory(_inputDir);
    }

    public void Dispose()
    {
        try { Directory.Delete(_tempDir, recursive: true); } catch { /* best-effort */ }
    }

    [Fact]
    public void RunNowWhileARunIsAlreadyInFlightRaisesRunAlreadyInProgressInsteadOfSilentlyDoingNothing()
    {
        StaTestRunner.RunStaAsync(async () =>
        {
            File.WriteAllText(Path.Combine(_inputDir, "report.csv"),
                "Patient First Name,Patient Last Name,Vaccine,Date Administered,Prescriber Name,Prescriber Fax\n" +
                "Test,Patient,Flu,2026-09-01,Dr. Synthetic,5555550200\n");

            var importLedger = new ImportLedger(Path.Combine(_tempDir, "imported.json"));
            var reportImporter = new ReportImporter(importLedger);
            var prescriberDirectory = new PrescriberDirectory(Path.Combine(_tempDir, "prescribers.json"));
            var faxClient = new FakeFaxClient();
            var faxLedger = new FaxLedger(Path.Combine(_tempDir, "ledger.json"));
            var orchestrator = new FaxRunOrchestrator(
                reportImporter, prescriberDirectory, new VaccineRecordPdfBuilder(),
                faxClient, faxLedger, importLedger, _faxRootDir);
            var runMarker = new FaxRunMarker(Path.Combine(_tempDir, "last-run.json"));

            var settings = new AppSettings
            {
                Fax = new FaxSettings
                {
                    InputFolder = _inputDir,
                    PharmacyName = "Test Pharmacy",
                    PharmacyPhone = "5555550100",
                    PharmacyFax = "5555550101",
                    SenderEmail = "sender@example.com",
                },
            };

            // Long intervals — this test never lets the timers actually
            // tick, it only calls RunNowAsync directly.
            var scheduler = new FaxRunScheduler(
                orchestrator, () => settings, runMarker,
                TimeSpan.FromHours(1), TimeSpan.FromHours(1));

            var alreadyInProgressCount = 0;
            scheduler.RunAlreadyInProgress += (_, _) => alreadyInProgressCount++;
            var completedCount = 0;
            scheduler.RunCompleted += (_, _) => completedCount++;

            // Held in a local, not re-read from faxClient.HoldNextQueueUntil
            // later — QueueAsync consumes (nulls out) that property the
            // moment it reads it (see FakeFaxClient's doc comment).
            var hold = new System.Threading.Tasks.TaskCompletionSource<bool>();
            faxClient.HoldNextQueueUntil = hold;

            var firstRun = scheduler.RunNowAsync();

            // Bounded wait for the first run to actually reach (and block
            // inside) QueueAsync, rather than an unconditional spin — see
            // FaxRunOrchestratorTests.RunsAreSerializedASecondConcurrentRunIsSkipped
            // for why this matters.
            var waited = TimeSpan.Zero;
            var pollInterval = TimeSpan.FromMilliseconds(10);
            while (faxClient.QueuedRequests.Count == 0)
            {
                if (waited > TimeSpan.FromSeconds(10))
                {
                    throw new TimeoutException("QueueAsync was never reached — see FaxRunOrchestrator's pipeline for what changed.");
                }
                await Task.Delay(pollInterval);
                waited += pollInterval;
            }

            // Second "Run now" while the first is still blocked inside
            // QueueAsync.
            await scheduler.RunNowAsync();

            Assert.Equal(1, alreadyInProgressCount);
            Assert.Equal(0, completedCount);

            hold.SetResult(true);
            await firstRun;

            Assert.Equal(1, completedCount);
            Assert.Equal(1, alreadyInProgressCount); // unchanged by the first run finishing
        });
    }
}
