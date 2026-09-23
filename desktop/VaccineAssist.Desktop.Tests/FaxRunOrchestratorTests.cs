using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class FaxRunOrchestratorTests : IDisposable
{
    private readonly string _tempDir;
    private readonly string _inputDir;
    private readonly string _faxRootDir;

    public FaxRunOrchestratorTests()
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

    private FaxRunOrchestrator MakeOrchestrator(
        out FakeFaxClient faxClient,
        out IPrescriberDirectory prescriberDirectory,
        IVaccineRecordPdfBuilder? pdfBuilder = null)
    {
        var importLedger = new ImportLedger(Path.Combine(_tempDir, "imported.json"));
        var reportImporter = new ReportImporter(importLedger);
        prescriberDirectory = new PrescriberDirectory(Path.Combine(_tempDir, "prescribers.json"));
        faxClient = new FakeFaxClient();
        var faxLedger = new FaxLedger(Path.Combine(_tempDir, "ledger.json"));

        return new FaxRunOrchestrator(
            reportImporter, prescriberDirectory, pdfBuilder ?? new VaccineRecordPdfBuilder(),
            faxClient, faxLedger, importLedger, _faxRootDir);
    }

    private FaxSettings MakeSettings() => new()
    {
        InputFolder = _inputDir,
        PharmacyName = "Test Pharmacy",
        PharmacyPhone = "5555550100",
        PharmacyFax = "5555550101",
        SenderEmail = "sender@example.com",
    };

    private void WriteReport(string fileName, string prescriberFax = "5555550200")
    {
        File.WriteAllText(Path.Combine(_inputDir, fileName),
            "Patient First Name,Patient Last Name,Vaccine,Date Administered,Prescriber Name,Prescriber Fax\n" +
            $"Test,Patient,Flu,2026-09-01,Dr. Synthetic,{prescriberFax}\n");
    }

    [Fact]
    public async Task SuccessfulRunQueuesTheFaxAndMarksTheLedgerInProcess()
    {
        WriteReport("report.csv");
        var orchestrator = MakeOrchestrator(out var faxClient, out _);

        var summary = await orchestrator.RunAsync(MakeSettings());

        Assert.NotNull(summary);
        Assert.Equal(1, summary!.RowsImported);
        Assert.Equal(1, summary.PatientsProcessed);
        Assert.Single(faxClient.QueuedRequests);
        Assert.Equal("5555550200", faxClient.QueuedRequests[0].ToFaxNumber);
    }

    [Fact]
    public async Task RunMovesTheSourceFileToProcessedFolder()
    {
        WriteReport("report.csv");
        var orchestrator = MakeOrchestrator(out _, out _);

        await orchestrator.RunAsync(MakeSettings());

        Assert.False(File.Exists(Path.Combine(_inputDir, "report.csv")));
        var processedFiles = Directory.GetFiles(Path.Combine(_inputDir, "processed"), "*.csv", SearchOption.AllDirectories);
        Assert.Single(processedFiles);
    }

    [Fact]
    public async Task RowWithNoResolvableFaxNumberIsNotSentAndNotFingerprinted()
    {
        // No Prescriber Fax column value and nothing in PrescriberDirectory.
        File.WriteAllText(Path.Combine(_inputDir, "report.csv"),
            "Patient First Name,Patient Last Name,Vaccine,Date Administered,Prescriber Name\n" +
            "Test,Patient,Flu,2026-09-01,Dr. Nobody\n");
        var orchestrator = MakeOrchestrator(out var faxClient, out _);

        var summary = await orchestrator.RunAsync(MakeSettings());

        Assert.Equal(1, summary!.NeedsFaxNumber);
        Assert.Empty(faxClient.QueuedRequests);

        // The row was moved (the FILE is processed regardless), but since
        // it was never fingerprinted, re-running the same import folder
        // structure with the SAME source file re-appearing would still
        // pick it up — verified here by re-importing directly against the
        // same import ledger the orchestrator used.
        var importLedger = new ImportLedger(Path.Combine(_tempDir, "imported.json"));
        Assert.Empty(importLedger.LoadFingerprints());
    }

    [Fact]
    public async Task PdfBuildFailureMarksTheEntryFailedAndStillFingerprintsIt()
    {
        WriteReport("report.csv");
        var orchestrator = MakeOrchestrator(out var faxClient, out _, new FaultyPdfBuilder());

        var summary = await orchestrator.RunAsync(MakeSettings());

        Assert.Equal(1, summary!.Failed);
        Assert.Empty(faxClient.QueuedRequests);

        var importLedger = new ImportLedger(Path.Combine(_tempDir, "imported.json"));
        Assert.Single(importLedger.LoadFingerprints());
    }

    [Fact]
    public async Task RunsAreSerializedASecondConcurrentRunIsSkipped()
    {
        WriteReport("report.csv");
        var orchestrator = MakeOrchestrator(out var faxClient, out _);
        // Held in a local, not re-read from faxClient.HoldNextQueueUntil
        // later — QueueAsync consumes (nulls out) that property the
        // moment it reads it, by design (see FakeFaxClient's doc comment).
        var hold = new TaskCompletionSource<bool>();
        faxClient.HoldNextQueueUntil = hold;

        var firstRunTask = orchestrator.RunAsync(MakeSettings());
        // Give the first run a chance to reach (and block inside)
        // QueueAsync — bounded rather than an unconditional spin, so a
        // regression that stops the run from ever reaching QueueAsync
        // (e.g. an exception earlier in the pipeline) fails this test
        // fast instead of hanging the whole CI run.
        var waited = TimeSpan.Zero;
        var pollInterval = TimeSpan.FromMilliseconds(10);
        while (faxClient.QueuedRequests.Count == 0)
        {
            if (waited > TimeSpan.FromSeconds(10))
            {
                throw new TimeoutException("QueueAsync was never reached — see FaxRunOrchestrator.RunAsync's pipeline for what changed.");
            }
            await Task.Delay(pollInterval);
            waited += pollInterval;
        }

        var secondResult = await orchestrator.RunAsync(MakeSettings());
        Assert.Null(secondResult); // skipped — a run was already in progress

        hold.SetResult(true);
        var firstResult = await firstRunTask;
        Assert.NotNull(firstResult);
    }

    [Fact]
    public async Task RetryAfterAddingAPrescriberFaxNumberSucceeds()
    {
        // The report has NO fax column at all and no directory entry yet —
        // this row comes back "needs fax number", not "failed" (a
        // vendor-level failure), so simulate a genuine Queue_Fax failure
        // instead by giving a fax number that SRFax rejects.
        WriteReport("report.csv", prescriberFax: "5555550200");
        var orchestrator = MakeOrchestrator(out var faxClient, out var prescriberDirectory);
        faxClient.QueueResults.Enqueue(new FaxQueueResult(false, null, "SRFax rejected the number"));

        var summary = await orchestrator.RunAsync(MakeSettings());
        Assert.Equal(1, summary!.Failed);
        var failedRow = summary.Rows.Single(r => r.Status == nameof(FaxLedgerStatus.Failed));

        // RetryFailedAsync re-resolves via PrescriberDirectory by name
        // (see FaxRunOrchestrator.RetryFailedAsync's own doc comment) —
        // add the prescriber there now, simulating Will fixing it in the
        // Settings window.
        prescriberDirectory.Save(new List<PrescriberDirectoryEntry>
        {
            new() { Name = "Dr. Synthetic", FaxNumber = "5555550300" },
        });

        var retried = await orchestrator.RetryFailedAsync(failedRow.LedgerEntryId, MakeSettings());

        Assert.True(retried);
        Assert.Equal(2, faxClient.QueuedRequests.Count);
        Assert.Equal("5555550300", faxClient.QueuedRequests[1].ToFaxNumber);
    }
}
