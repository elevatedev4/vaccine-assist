using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>V-T65 (2026-09-29): FaxRunOrchestrator now runs against ONE
/// user-picked report file (RunAsync(reportFilePath, settings)) — no input
/// folder, no processed\ move, no PrescriberDirectory fallback. The
/// report's own Primary Care Prescriber Fax column is the only fax-number
/// source.</summary>
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
        IVaccineRecordPdfBuilder? pdfBuilder = null)
    {
        return MakeOrchestrator(out faxClient, out _, out _, pdfBuilder);
    }

    private FaxRunOrchestrator MakeOrchestrator(
        out FakeFaxClient faxClient,
        out FaxLedger faxLedger,
        out FaxFileLedger fileLedger,
        IVaccineRecordPdfBuilder? pdfBuilder = null)
    {
        var importLedger = new ImportLedger(Path.Combine(_tempDir, "imported.json"));
        var reportImporter = new ReportImporter(importLedger);
        faxClient = new FakeFaxClient();
        faxLedger = new FaxLedger(Path.Combine(_tempDir, "ledger.json"));
        fileLedger = new FaxFileLedger(Path.Combine(_tempDir, "sent-files.json"));

        return new FaxRunOrchestrator(
            reportImporter, pdfBuilder ?? new VaccineRecordPdfBuilder(),
            faxClient, faxLedger, importLedger, _faxRootDir, fileLedger);
    }

    private static FaxSettings MakeSettings() => new()
    {
        PharmacyName = "Test Pharmacy",
        PharmacyPhone = "5555550100",
        PharmacyFax = "5555550101",
        SenderEmail = "sender@example.com",
    };

    // Headers match FaxColumnMap's DEFAULT (Pioneer's real export, V-T53
    // 401/column-map follow-up, DOB added as a required column by the
    // fax-report-layout brief, 2026-09-28) since MakeSettings() doesn't
    // override ColumnMap — "Patient, Test" is one CSV field (quoted,
    // since it has an internal comma) so ReportRowParser splits it into
    // PatientLastName="Patient"/PatientFirstName="Test".
    private string WriteReport(string fileName, string prescriberFax = "5555550200", string prescriberName = "Dr. Synthetic")
    {
        var path = Path.Combine(_inputDir, fileName);
        File.WriteAllText(path,
            "Patient Full Name Last then First,Patient Date of Birth,Dispensed Item Name,Immunization Administered On,Primary Care Prescriber,Primary Care Prescriber Fax\n" +
            $"\"Patient, Test\",1980-01-15,Flu,2026-09-01,{prescriberName},{prescriberFax}\n");
        return path;
    }

    [Fact]
    public async Task SuccessfulRunQueuesTheFaxAndMarksTheLedgerInProcess()
    {
        var reportPath = WriteReport("report.csv");
        var orchestrator = MakeOrchestrator(out var faxClient);

        var summary = await orchestrator.RunAsync(reportPath, MakeSettings());

        Assert.NotNull(summary);
        Assert.Equal(1, summary!.RowsImported);
        Assert.Equal(1, summary.PatientsProcessed);
        Assert.Single(faxClient.QueuedRequests);
        Assert.Equal("5555550200", faxClient.QueuedRequests[0].ToFaxNumber);
    }

    [Fact]
    public async Task SourceFileIsNeverMovedOrDeleted()
    {
        // V-T65: no input folder / processed\ subfolder anymore — the
        // picked file stays exactly where it was (see
        // FaxRunOrchestrator's own doc comment on removing MoveAcceptedFiles).
        var reportPath = WriteReport("report.csv");
        var orchestrator = MakeOrchestrator(out _);

        await orchestrator.RunAsync(reportPath, MakeSettings());

        Assert.True(File.Exists(reportPath));
        Assert.False(Directory.Exists(Path.Combine(_inputDir, "processed")));
    }

    [Fact]
    public async Task UpdateFaxClientSwapsWhichClientTheNextRunUses()
    {
        // Notifyre-key-visibility follow-up (Will, 2026-09-28): confirms
        // the fix for App.xaml.cs's documented "not done for phase 1" gap
        // — a credential/provider change must take effect on the very
        // next run without an app restart, i.e. without rebuilding the
        // whole FaxRunOrchestrator.
        var reportPath = WriteReport("report.csv");
        var orchestrator = MakeOrchestrator(out var originalClient);
        var replacementClient = new FakeFaxClient();

        orchestrator.UpdateFaxClient(replacementClient);
        await orchestrator.RunAsync(reportPath, MakeSettings());

        Assert.Empty(originalClient.QueuedRequests);
        Assert.Single(replacementClient.QueuedRequests);
    }

    [Fact]
    public async Task RowWithNoResolvableFaxNumberIsSkippedNotSentAndNotFingerprinted()
    {
        // No Prescriber Fax column value at all — V-T65: the report's own
        // column is the ONLY source now, no directory fallback.
        var reportPath = Path.Combine(_inputDir, "report.csv");
        File.WriteAllText(reportPath,
            "Patient Full Name Last then First,Patient Date of Birth,Dispensed Item Name,Immunization Administered On,Primary Care Prescriber\n" +
            "\"Patient, Test\",1980-01-15,Flu,2026-09-01,Dr. Nobody\n");
        var orchestrator = MakeOrchestrator(out var faxClient);

        var summary = await orchestrator.RunAsync(reportPath, MakeSettings());

        Assert.Equal(1, summary!.SkippedNoFax);
        Assert.Empty(faxClient.QueuedRequests);
        var skippedRow = summary.Rows.Single();
        Assert.Equal("Skipped (no prescriber fax)", skippedRow.Status);
        // Fax-report-layout brief (2026-09-28): never nagged as an error.
        Assert.Null(skippedRow.Error);

        // Never fingerprinted — re-importing the same file (or a
        // re-exported one) after the report gains a fax column must still
        // pick this row up.
        var importLedger = new ImportLedger(Path.Combine(_tempDir, "imported.json"));
        Assert.Empty(importLedger.LoadFingerprints());
    }

    [Fact]
    public async Task RowWithBlankPrescriberNameIsSkippedEvenWithAUsableFaxNumberInTheReport()
    {
        // Fax-report-layout brief (2026-09-28, verbatim): "rows with an
        // empty prescriber OR empty/invalid fax are skipped silently" —
        // an empty prescriber name skips even though this row's fax
        // column has a perfectly valid number, since the letter's "To:"
        // block needs someone to address it to.
        var reportPath = WriteReport("report.csv", prescriberFax: "5555550200", prescriberName: "");
        var orchestrator = MakeOrchestrator(out var faxClient);

        var summary = await orchestrator.RunAsync(reportPath, MakeSettings());

        Assert.Equal(1, summary!.SkippedNoFax);
        Assert.Equal(0, summary.Failed);
        Assert.Empty(faxClient.QueuedRequests);
    }

    [Fact]
    public async Task PdfBuildFailureMarksTheEntryFailedAndStillFingerprintsIt()
    {
        var reportPath = WriteReport("report.csv");
        var orchestrator = MakeOrchestrator(out var faxClient, new FaultyPdfBuilder());

        var summary = await orchestrator.RunAsync(reportPath, MakeSettings());

        Assert.Equal(1, summary!.Failed);
        Assert.Empty(faxClient.QueuedRequests);

        var importLedger = new ImportLedger(Path.Combine(_tempDir, "imported.json"));
        Assert.Single(importLedger.LoadFingerprints());
    }

    [Fact]
    public async Task RunsAreSerializedASecondConcurrentRunIsSkipped()
    {
        var reportPath = WriteReport("report.csv");
        var orchestrator = MakeOrchestrator(out var faxClient);
        // Held in a local, not re-read from faxClient.HoldNextQueueUntil
        // later — QueueAsync consumes (nulls out) that property the
        // moment it reads it, by design (see FakeFaxClient's doc comment).
        var hold = new TaskCompletionSource<bool>();
        faxClient.HoldNextQueueUntil = hold;

        var firstRunTask = orchestrator.RunAsync(reportPath, MakeSettings());
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

        var secondResult = await orchestrator.RunAsync(reportPath, MakeSettings());
        Assert.Null(secondResult); // skipped — a run was already in progress

        hold.SetResult(true);
        var firstResult = await firstRunTask;
        Assert.NotNull(firstResult);
    }

    [Fact]
    public async Task RetryReSendsToTheSameFaxNumberTheEntryWasOriginallyQueuedTo()
    {
        // V-T65: the prescriber-fax directory is gone — RetryFailedAsync
        // re-sends to FaxLedgerEntry.FaxNumber (captured from the report's
        // own column at import time), not a re-resolved lookup.
        var reportPath = WriteReport("report.csv", prescriberFax: "5555550200");
        var orchestrator = MakeOrchestrator(out var faxClient);
        faxClient.QueueResults.Enqueue(new FaxQueueResult(false, null, "vendor rejected the number"));

        var summary = await orchestrator.RunAsync(reportPath, MakeSettings());
        Assert.Equal(1, summary!.Failed);
        var failedRow = summary.Rows.Single(r => r.Status == nameof(FaxLedgerStatus.Failed));
        Assert.Equal("0200", failedRow.FaxNumberLast4);

        var retried = await orchestrator.RetryFailedAsync(failedRow.LedgerEntryId, MakeSettings());

        Assert.True(retried);
        Assert.Equal(2, faxClient.QueuedRequests.Count);
        Assert.Equal("5555550200", faxClient.QueuedRequests[1].ToFaxNumber);
    }

    // ---- V-T65 R5 (Will, verbatim, 2026-09-29): "Fax went through.
    // Received it perfectly. But it still shows status 'InProcess' in the
    // app. Need to make sure this stuff updates. Need to also ...  make
    // sure that things don't get re-sent if somebody reuploads the same
    // file." ----

    [Fact]
    public async Task ReimportingTheSameReportShowsSkippedAlreadySentInsteadOfSilentlyDroppingTheRow()
    {
        var reportPath = WriteReport("report.csv");
        var orchestrator = MakeOrchestrator(out var faxClient);

        var first = await orchestrator.RunAsync(reportPath, MakeSettings());
        Assert.Equal(1, first!.InProcess);

        var second = await orchestrator.RunAsync(reportPath, MakeSettings());

        Assert.NotNull(second);
        Assert.Equal(1, second!.SkippedAlreadySent);
        Assert.Equal(0, second.RowsImported);
        var skippedRow = second.Rows.Single();
        Assert.StartsWith("Skipped — already sent", skippedRow.Status);
        // Still only ONE fax ever queued — the duplicate never re-sent.
        Assert.Single(faxClient.QueuedRequests);
    }

    [Fact]
    public async Task AVendorQueueFailureIsNotFingerprintedSoReimportingRetriesIt()
    {
        // Will, verbatim: "failed ones are retried." Distinct from
        // PdfBuildFailureMarksTheEntryFailedAndStillFingerprintsIt — THAT
        // failure is a template/code problem a resend can't fix; a vendor
        // QUEUE failure (e.g. a bad fax number that Will then corrects) is
        // exactly the case re-uploading the report should retry.
        var reportPath = WriteReport("report.csv");
        var orchestrator = MakeOrchestrator(out var faxClient);
        faxClient.QueueResults.Enqueue(new FaxQueueResult(false, null, "vendor rejected the number"));

        var first = await orchestrator.RunAsync(reportPath, MakeSettings());
        Assert.Equal(1, first!.Failed);

        // Re-import the SAME file/row — a genuine vendor failure must not
        // be permanently excluded like a real duplicate would be.
        var second = await orchestrator.RunAsync(reportPath, MakeSettings());

        Assert.Equal(0, second!.SkippedAlreadySent);
        Assert.Equal(1, second.RowsImported);
        Assert.Equal(2, faxClient.QueuedRequests.Count);
    }

    [Fact]
    public async Task ReuploadingAFullySentFileIsSkippedBeforeSendingAnythingElse()
    {
        var reportPath = WriteReport("report.csv");
        var orchestrator = MakeOrchestrator(out var faxClient);
        // FakeFaxClient assigns "fax-1" to the first queued request
        // (1-based on QueuedRequests.Count) — pre-configuring its status
        // means the second poll pass inside RunAsync resolves it to Sent
        // before RunAsync even returns, no background polling needed.
        faxClient.StatusResults["fax-1"] = new FaxStatusResult(true, FaxSendStatus.Sent, null, null);

        var first = await orchestrator.RunAsync(reportPath, MakeSettings());
        Assert.Equal(1, first!.Sent);

        var second = await orchestrator.RunAsync(reportPath, MakeSettings());

        Assert.NotNull(second!.AlreadySentMessage);
        Assert.Contains("already fully sent", second.AlreadySentMessage);
        Assert.Equal(0, second.Sent);
        Assert.Empty(second.Rows);
        // No second attempt to queue anything for this file.
        Assert.Single(faxClient.QueuedRequests);
    }

    [Fact]
    public async Task ADifferentFileWithDifferentContentIsNotTreatedAsAlreadySent()
    {
        var reportPath = WriteReport("report.csv");
        var orchestrator = MakeOrchestrator(out var faxClient);
        faxClient.StatusResults["fax-1"] = new FaxStatusResult(true, FaxSendStatus.Sent, null, null);
        await orchestrator.RunAsync(reportPath, MakeSettings());

        // A different patient/DOB/vaccine/date -> a different row
        // fingerprint AND different file bytes -> a different file hash.
        var otherPath = Path.Combine(_inputDir, "report2.csv");
        File.WriteAllText(otherPath,
            "Patient Full Name Last then First,Patient Date of Birth,Dispensed Item Name,Immunization Administered On,Primary Care Prescriber,Primary Care Prescriber Fax\n" +
            "\"Other, Person\",1990-05-20,Flu,2026-09-02,Dr. Synthetic,5555550200\n");

        var second = await orchestrator.RunAsync(otherPath, MakeSettings());

        Assert.Null(second!.AlreadySentMessage);
        Assert.Equal(1, second.RowsImported);
        Assert.Equal(2, faxClient.QueuedRequests.Count);
    }
}
