using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// The whole "one daily run" pipeline (Will's brief): import -> build one
/// PDF per (patient, prescriber) group -> queue each via IFaxClient ->
/// ledger -> poll receipts -> write runs\<timestamp>.json -> return the
/// summary FaxRunSummaryWindow displays. FaxRunScheduler (WPF-adjacent:
/// DispatcherTimer + tray/summary-window plumbing) is the only production
/// caller.
///
/// SERIALIZATION: RunAsync uses a SemaphoreSlim(1,1) with a
/// non-blocking WaitAsync(0) — a second call while one is already running
/// returns null immediately rather than queuing up or running
/// concurrently (Will's brief: "Runs are serialized (never two at
/// once)"). This ALSO doubles as the guard against two runs
/// double-importing the same report rows before either has persisted
/// anything — see ReportImporter's own doc comment.
/// </summary>
public sealed class FaxRunOrchestrator
{
    private static readonly JsonSerializerOptions RunFileJsonOptions = new()
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() },
    };

    private readonly IReportImporter _importer;
    private readonly IPrescriberDirectory _prescriberDirectory;
    private readonly IVaccineRecordPdfBuilder _pdfBuilder;
    private readonly IFaxClient _faxClient;
    private readonly IFaxLedger _ledger;
    private readonly IImportLedger _importLedger;
    private readonly string _faxRootDir;
    private readonly SemaphoreSlim _runLock = new(1, 1);

    public FaxRunOrchestrator(
        IReportImporter importer,
        IPrescriberDirectory prescriberDirectory,
        IVaccineRecordPdfBuilder pdfBuilder,
        IFaxClient faxClient,
        IFaxLedger ledger,
        IImportLedger importLedger,
        string faxRootDir)
    {
        _importer = importer;
        _prescriberDirectory = prescriberDirectory;
        _pdfBuilder = pdfBuilder;
        _faxClient = faxClient;
        _ledger = ledger;
        _importLedger = importLedger;
        _faxRootDir = faxRootDir;
    }

    /// <summary>True while a run is currently in progress.</summary>
    public bool IsRunning => _runLock.CurrentCount == 0;

    /// <summary>Runs the full pipeline once. Returns null (a no-op,
    /// logged, never thrown) if a run is already in progress.</summary>
    public async Task<FaxRunSummary?> RunAsync(FaxSettings settings, CancellationToken ct = default)
    {
        if (!await _runLock.WaitAsync(0, ct))
        {
            AppFileLog.Log("[FaxRunOrchestrator] Run requested while one is already in progress — skipped.");
            return null;
        }

        try
        {
            return await RunCoreAsync(settings, ct);
        }
        finally
        {
            _runLock.Release();
        }
    }

    /// <summary>Standalone receipt poll (no import/PDF/queue work) —
    /// FaxRunScheduler's 10-minute timer between full runs (Will's brief:
    /// "A receipt poller checks 'In Process' entries every 10 min (and at
    /// the start of each run)" — RunAsync's own internal polls cover the
    /// second half of that). Guarded by the same run lock so it never
    /// races a full run's own ledger read/write — a no-op (not an error)
    /// if a full run happens to be in progress, since that run already
    /// polls internally.</summary>
    public async Task PollReceiptsOnlyAsync(CancellationToken ct = default)
    {
        if (!await _runLock.WaitAsync(0, ct)) return;
        try
        {
            await new FaxReceiptPoller(_ledger, _faxClient).PollAsync(ct);
        }
        finally
        {
            _runLock.Release();
        }
    }

    /// <summary>Failed faxes get a Retry action in the summary window
    /// (Will's brief: "explicit user click only"). Re-resolves the fax
    /// number via PrescriberDirectory by the ledger entry's stored
    /// prescriber name (the ledger itself only ever stores the last 4
    /// digits — see FaxLedgerEntry's own doc comment — so a fax number
    /// that came from the REPORT column rather than prescribers.json
    /// can't be recovered here; add it to prescribers.json first if
    /// retrying that case).</summary>
    public async Task<bool> RetryFailedAsync(string ledgerEntryId, FaxSettings settings, CancellationToken ct = default)
    {
        var entries = _ledger.Load();
        var entry = entries.FirstOrDefault(e => e.Id == ledgerEntryId);
        if (entry is null || entry.Status != FaxLedgerStatus.Failed) return false;
        if (string.IsNullOrWhiteSpace(entry.PdfPath) || !File.Exists(entry.PdfPath)) return false;

        var faxNumber = FaxNumberNormalizer.ToDialableOrNull(_prescriberDirectory.TryGetFaxNumber(entry.PrescriberName, null));
        if (faxNumber is null)
        {
            entry.Error = "Retry failed: no fax number on file for this prescriber — add one in Fax settings first.";
            _ledger.Save(entries);
            return false;
        }

        var pdfBytes = await File.ReadAllBytesAsync(entry.PdfPath, ct);
        var request = new FaxRequest(
            faxNumber, pdfBytes, Path.GetFileName(entry.PdfPath),
            settings.PharmacyFax, settings.SenderEmail, settings.AccountCode);

        FaxQueueResult result;
        try
        {
            result = await _faxClient.QueueAsync(request, ct);
        }
        catch (Exception ex)
        {
            result = new FaxQueueResult(false, null, ex.Message);
            AppFileLog.LogException("FaxRunOrchestrator.RetryFailedAsync", ex);
        }

        if (result.Success)
        {
            entry.FaxId = result.FaxId;
            entry.Status = FaxLedgerStatus.InProcess;
            entry.Error = null;
            entry.QueuedAtUtc = DateTime.UtcNow;
        }
        else
        {
            entry.Error = result.ErrorMessage;
        }

        _ledger.Save(entries);
        return result.Success;
    }

    private async Task<FaxRunSummary> RunCoreAsync(FaxSettings settings, CancellationToken ct)
    {
        var runAtUtc = DateTime.UtcNow;
        var runDate = DateOnly.FromDateTime(DateTime.Now);
        var poller = new FaxReceiptPoller(_ledger, _faxClient);

        // Brief: "A receipt poller checks 'In Process' entries ... at the
        // start of each run."
        await poller.PollAsync(ct);

        var importOutcome = _importer.Import(settings.InputFolder, settings.ColumnMap);
        var groups = FaxGrouping.GroupByPatientAndPrescriber(importOutcome.NewRecords);

        var summary = new FaxRunSummary
        {
            RunAtUtc = runAtUtc,
            RowsImported = importOutcome.NewRecords.Count,
            SkippedRows = importOutcome.SkippedRowCount,
            DuplicateRows = importOutcome.DuplicateRowCount,
            PatientsProcessed = groups.Count,
            RejectedFiles = importOutcome.RejectedFiles
                .Select(f => $"{Path.GetFileName(f.FilePath)}: {f.Reason}")
                .ToList(),
        };

        var ledgerEntries = _ledger.Load();
        var newFingerprints = new List<string>();
        var thisRunEntryIds = new HashSet<string>();
        var outboxDir = Path.Combine(_faxRootDir, "outbox", runDate.ToString("yyyyMMdd"));

        foreach (var group in groups)
        {
            var resolvedFax =
                FaxNumberNormalizer.ToDialableOrNull(group.PrescriberFaxFromReport) ??
                FaxNumberNormalizer.ToDialableOrNull(_prescriberDirectory.TryGetFaxNumber(group.PrescriberName, group.PrescriberNpi));

            if (resolvedFax is null)
            {
                summary.NeedsFaxNumber++;
                summary.Rows.Add(new FaxRunRowSummary
                {
                    PatientInitials = group.PatientInitials,
                    PrescriberName = group.PrescriberName ?? "(unknown prescriber)",
                    Status = nameof(FaxLedgerStatus.NeedsFaxNumber),
                    Error = "No fax number on file for this prescriber.",
                });
                // NOT fingerprinted — see ReportImporter's doc comment on
                // why: these rows must still be pick-up-able once Will
                // adds a fax number and the report reappears/re-runs.
                continue;
            }

            var entry = new FaxLedgerEntry
            {
                PatientInitials = group.PatientInitials,
                RowFingerprints = group.Records.Select(r => r.Fingerprint).ToList(),
                PrescriberName = group.PrescriberName,
                FaxNumberLast4 = FaxNumberNormalizer.Last4(resolvedFax),
                QueuedAtUtc = DateTime.UtcNow,
                Status = FaxLedgerStatus.Queued,
            };
            thisRunEntryIds.Add(entry.Id);

            byte[] pdfBytes;
            try
            {
                pdfBytes = _pdfBuilder.Build(group, settings).PdfBytes;
            }
            catch (Exception ex)
            {
                entry.Status = FaxLedgerStatus.Failed;
                entry.Error = $"Couldn't build PDF: {ex.Message}";
                ledgerEntries.Add(entry);
                newFingerprints.AddRange(entry.RowFingerprints);
                AppFileLog.LogException("FaxRunOrchestrator.BuildPdf", ex);
                continue;
            }

            if (!Directory.Exists(outboxDir))
            {
                Directory.CreateDirectory(outboxDir);
            }
            var pdfPath = Path.Combine(outboxDir, $"{entry.Id}.pdf");
            await File.WriteAllBytesAsync(pdfPath, pdfBytes, ct);
            entry.PdfPath = pdfPath;

            var request = new FaxRequest(
                resolvedFax, pdfBytes, $"{entry.Id}.pdf",
                settings.PharmacyFax, settings.SenderEmail, settings.AccountCode);

            FaxQueueResult queueResult;
            try
            {
                queueResult = await _faxClient.QueueAsync(request, ct);
            }
            catch (Exception ex)
            {
                queueResult = new FaxQueueResult(false, null, ex.Message);
                AppFileLog.LogException("FaxRunOrchestrator.QueueAsync", ex);
            }

            if (queueResult.Success)
            {
                entry.FaxId = queueResult.FaxId;
                entry.Status = FaxLedgerStatus.InProcess;
            }
            else
            {
                entry.Status = FaxLedgerStatus.Failed;
                entry.Error = queueResult.ErrorMessage;
                FaxOutboxPaths.MoveToTerminalFolder(entry, "failed");
            }

            ledgerEntries.Add(entry);
            // Fingerprinted now that this group made it far enough to
            // count as processed (queued, or a real vendor-side
            // failure) — never for NeedsFaxNumber, see above.
            newFingerprints.AddRange(entry.RowFingerprints);

            AppFileLog.Log($"[FaxRunOrchestrator] {entry.PatientInitials} -> {entry.PrescriberName ?? "?"} ({entry.FaxNumberLast4}): {entry.Status}");
        }

        _ledger.Save(ledgerEntries);
        if (newFingerprints.Count > 0)
        {
            _importLedger.AddFingerprints(newFingerprints);
        }

        // Only after every group above has been attempted — see
        // ReportImporter's own doc comment.
        _importer.MoveAcceptedFiles(importOutcome.AcceptedFilePaths, settings.InputFolder, runDate);

        // A second poll pass right after queuing — a nicer first-look
        // summary if SRFax resolves a fast fax immediately; the
        // scheduler's own 10-minute timer is what carries the rest of
        // the way to Sent/Failed (see FaxRunScheduler).
        await poller.PollAsync(ct);

        var finalLedger = _ledger.Load();
        foreach (var entry in finalLedger.Where(e => thisRunEntryIds.Contains(e.Id)))
        {
            switch (entry.Status)
            {
                case FaxLedgerStatus.Sent: summary.Sent++; break;
                case FaxLedgerStatus.Failed: summary.Failed++; break;
                default: summary.InProcess++; break; // Queued or InProcess — both mean "not resolved yet"
            }
            summary.Rows.Add(new FaxRunRowSummary
            {
                PatientInitials = entry.PatientInitials,
                PrescriberName = entry.PrescriberName ?? "(unknown prescriber)",
                Status = entry.Status.ToString(),
                Error = entry.Error,
                LedgerEntryId = entry.Id,
            });
        }

        WriteRunSummaryFile(summary);
        return summary;
    }

    private void WriteRunSummaryFile(FaxRunSummary summary)
    {
        try
        {
            var runsDir = Path.Combine(_faxRootDir, "runs");
            if (!Directory.Exists(runsDir))
            {
                Directory.CreateDirectory(runsDir);
            }

            var path = Path.Combine(runsDir, $"{summary.RunAtUtc:yyyyMMdd-HHmmss}.json");
            var json = JsonSerializer.Serialize(summary, RunFileJsonOptions);
            File.WriteAllText(path, json);
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("FaxRunOrchestrator.WriteRunSummaryFile", ex);
        }
    }
}
