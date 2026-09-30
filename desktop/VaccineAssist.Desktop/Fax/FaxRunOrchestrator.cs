using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Fax;

/// <summary>Read-only result of FaxRunOrchestrator.Preview — the file
/// parsed but NOT sent, plus which (date, vaccine) pairs already look
/// sent per FaxFileLedger. FaxSendCoordinator calls this before RunAsync
/// so it knows whether to show the duplicate-confirmation dialog.</summary>
public sealed record FaxDuplicateCheckResult(ImportOutcome ImportOutcome, IReadOnlyList<FaxDuplicateMatch> Duplicates);

/// <summary>
/// The whole "one daily run" pipeline (Will's brief): import -> build one
/// PDF per (patient, prescriber) group -> queue each via IFaxClient ->
/// ledger -> poll receipts -> write runs\<timestamp>.json -> return the
/// summary Views/FaxSendWindow.xaml displays. FaxRunScheduler (WPF-adjacent:
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
///
/// V-T65 R6 (Will, verbatim, 2026-09-29): "How is the app determining
/// what has already been sent? We can't store patient name ... we should
/// just store the administration dates, quantity on each date, and look
/// for duplicates that way, then show an alert, allowing them to continue
/// and potentially send duplicates, cancel altogether, or only send
/// non-duplicates." Replaces the old per-row SHA-256 fingerprint dedupe
/// (RowFingerprint/ImportLedger/the whole-file FaxFileHasher refusal) with
/// Preview (read-only duplicate check) + RunAsync's duplicateChoice
/// parameter — see FaxDuplicateDetector for the actual matching logic.
/// </summary>
public sealed class FaxRunOrchestrator
{
    private static readonly JsonSerializerOptions RunFileJsonOptions = new()
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() },
    };

    /// <summary>Per-row Status text for a skipped (no usable prescriber
    /// fax) group — a plain string rather than a FaxLedgerStatus enum
    /// value, since a skipped group never actually becomes a
    /// FaxLedgerEntry (see the skip branch's own comment below).</summary>
    private const string SkippedNoFaxStatus = "Skipped (no prescriber fax)";

    private readonly IReportImporter _importer;
    private readonly IVaccineRecordPdfBuilder _pdfBuilder;

    /// <summary>NOT readonly (Notifyre-key-visibility follow-up, Will
    /// 2026-09-28) — App.xaml.cs originally built this ONCE at startup
    /// from whatever credentials were on disk THEN, so saving a new
    /// Notifyre token in Fax settings never took effect until the app
    /// restarted (see App.xaml.cs's own "not done for phase 1" comment on
    /// this class's construction). UpdateFaxClient lets MainWindow swap
    /// in a freshly-built client (fresh credentials re-read from
    /// FaxCredentialStore) right after a Settings save, so every run/
    /// retry/poll after that point uses the STORED token, never a stale
    /// in-memory one.</summary>
    private IFaxClient _faxClient;
    private readonly IFaxLedger _ledger;
    private readonly string _faxRootDir;
    private readonly IFaxFileLedger _fileLedger;
    private readonly SemaphoreSlim _runLock = new(1, 1);

    public FaxRunOrchestrator(
        IReportImporter importer,
        IVaccineRecordPdfBuilder pdfBuilder,
        IFaxClient faxClient,
        IFaxLedger ledger,
        string faxRootDir,
        IFaxFileLedger fileLedger)
    {
        _importer = importer;
        _pdfBuilder = pdfBuilder;
        _faxClient = faxClient;
        _ledger = ledger;
        _faxRootDir = faxRootDir;
        _fileLedger = fileLedger;
    }

    /// <summary>Where FaxRunSummary JSON files (fax\runs\*.json) live —
    /// exposed so Views/FaxSendWindow.xaml's Send History section
    /// (FaxRunHistoryStore) reads from the SAME root this orchestrator
    /// writes to, without duplicating the path computation.</summary>
    public string FaxRootDir => _faxRootDir;

    /// <summary>True while a run is currently in progress.</summary>
    public bool IsRunning => _runLock.CurrentCount == 0;

    /// <summary>Swaps in a freshly-built IFaxClient (see the field's own
    /// doc comment) — called by MainWindow right after Fax settings
    /// persists a credential/provider change, so the next run/retry/poll
    /// picks it up without an app restart. Never called mid-run in
    /// practice (Settings' Save button is disabled while IsBusy, and a
    /// run holding _runLock doesn't block this simple field swap either
    /// way — the in-flight run just finishes with whichever client
    /// instance it already captured locally, which is fine since a
    /// single run is short-lived).</summary>
    public void UpdateFaxClient(IFaxClient faxClient) => _faxClient = faxClient;

    /// <summary>Read-only: parses <paramref name="reportFilePath"/> (same
    /// importer RunAsync itself uses) and checks its (date, vaccine)
    /// summary against FaxFileLedger — no ledger writes, no sending, no
    /// run-lock. Safe to call as many times as Will re-picks a file.
    /// FaxSendCoordinator calls this right before RunAsync so it knows
    /// whether to show the duplicate-confirmation dialog.</summary>
    public FaxDuplicateCheckResult Preview(string reportFilePath, FaxColumnMap columnMap)
    {
        var importOutcome = _importer.ImportFile(reportFilePath, columnMap);
        var newEntries = FaxDuplicateDetector.Summarize(importOutcome.NewRecords);
        var duplicates = FaxDuplicateDetector.FindDuplicates(newEntries, _fileLedger.Load());
        return new FaxDuplicateCheckResult(importOutcome, duplicates);
    }

    /// <summary>Runs the full pipeline once against ONE user-picked report
    /// file (V-T65: tray icon -> Views/FaxSendWindow.xaml's file picker,
    /// then this runs only once Will presses Send there — R4, 2026-09-29;
    /// no input folder, no scan). Returns null (a no-op, logged,
    /// never thrown) if a run is already in progress.
    ///
    /// <paramref name="duplicateChoice"/> (V-T65 R6) — Will's answer on
    /// FaxSendCoordinator's duplicate-confirmation dialog when Preview
    /// found any (date, vaccine) pairs already in FaxFileLedger:
    /// SendAll sends every row including the duplicates; SendOnlyNew
    /// filters them out first. Defaults to SendAll so a caller that never
    /// calls Preview (e.g. every existing test/RetryFailedAsync-only
    /// caller) behaves exactly as before — "just send it."</summary>
    public async Task<FaxRunSummary?> RunAsync(
        string reportFilePath,
        FaxSettings settings,
        FaxDuplicateChoice duplicateChoice = FaxDuplicateChoice.SendAll,
        CancellationToken ct = default)
    {
        if (!await _runLock.WaitAsync(0, ct))
        {
            AppFileLog.Log("[FaxRunOrchestrator] Run requested while one is already in progress — skipped.");
            return null;
        }

        try
        {
            return await RunCoreAsync(reportFilePath, settings, duplicateChoice, ct);
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
    /// (Will's brief: "explicit user click only"). Re-sends to the SAME
    /// fax number this entry was originally queued to (FaxLedgerEntry.
    /// FaxNumber — V-T65: the prescriber-fax directory is gone, the
    /// report's own column was the only source at import time, so the
    /// number is captured on the ledger entry itself rather than
    /// re-resolved here).</summary>
    public async Task<bool> RetryFailedAsync(string ledgerEntryId, FaxSettings settings, CancellationToken ct = default)
    {
        var entries = _ledger.Load();
        var entry = entries.FirstOrDefault(e => e.Id == ledgerEntryId);
        if (entry is null || entry.Status != FaxLedgerStatus.Failed) return false;
        if (string.IsNullOrWhiteSpace(entry.PdfPath) || !File.Exists(entry.PdfPath)) return false;

        var faxNumber = FaxNumberNormalizer.ToDialableOrNull(entry.FaxNumber);
        if (faxNumber is null)
        {
            entry.Error = "Retry failed: no fax number on file for this entry.";
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

    private async Task<FaxRunSummary> RunCoreAsync(
        string reportFilePath, FaxSettings settings, FaxDuplicateChoice duplicateChoice, CancellationToken ct)
    {
        var runAtUtc = DateTime.UtcNow;
        var runDate = DateOnly.FromDateTime(DateTime.Now);
        var fileName = Path.GetFileName(reportFilePath);

        var poller = new FaxReceiptPoller(_ledger, _faxClient);

        // Brief: "A receipt poller checks 'In Process' entries ... at the
        // start of each run."
        await poller.PollAsync(ct);

        var importOutcome = _importer.ImportFile(reportFilePath, settings.ColumnMap);

        // V-T65 R6: (date, vaccine, count) duplicate check against
        // FaxFileLedger — see FaxDuplicateDetector. duplicateChoice is
        // whatever FaxSendCoordinator already got Will to confirm (via
        // Preview + the duplicate-confirmation dialog) before calling
        // RunAsync at all; this re-derives the same matches from the
        // CURRENT ledger rather than trusting a possibly-stale Preview.
        var newEntries = FaxDuplicateDetector.Summarize(importOutcome.NewRecords);
        var duplicates = FaxDuplicateDetector.FindDuplicates(newEntries, _fileLedger.Load());

        List<ImmunizationRecord> recordsToSend;
        List<ImmunizationRecord> recordsSkippedAsDuplicate;
        if (duplicateChoice == FaxDuplicateChoice.SendOnlyNew && duplicates.Count > 0)
        {
            recordsToSend = FaxDuplicateDetector.FilterOutDuplicates(importOutcome.NewRecords, duplicates);
            var sendKeys = new HashSet<(string Date, string VaccineKey)>(recordsToSend.Select(FaxDuplicateDetector.KeyFor));
            recordsSkippedAsDuplicate = importOutcome.NewRecords
                .Where(r => !sendKeys.Contains(FaxDuplicateDetector.KeyFor(r)))
                .ToList();
        }
        else
        {
            recordsToSend = importOutcome.NewRecords.ToList();
            recordsSkippedAsDuplicate = new List<ImmunizationRecord>();
        }

        var groups = FaxGrouping.GroupByPatientAndPrescriber(recordsToSend);

        var summary = new FaxRunSummary
        {
            RunAtUtc = runAtUtc,
            FileName = fileName,
            RowsImported = importOutcome.NewRecords.Count,
            SkippedRows = importOutcome.SkippedRowCount,
            PatientsProcessed = groups.Count,
            RejectedFiles = importOutcome.RejectedFiles
                .Select(f => $"{Path.GetFileName(f.FilePath)}: {f.Reason}")
                .ToList(),
        };

        // V-T65 R6: rows Will chose to leave out via "Send only new rows"
        // are still shown, not silently dropped — grouped the same way
        // real sends are, with the (date, vaccine) match's own
        // PreviouslySentRunAtUtc as the "batch" date.
        if (recordsSkippedAsDuplicate.Count > 0)
        {
            var duplicatesByKey = duplicates.ToDictionary(
                d => (d.AdministeredDate, FaxDuplicateDetector.NormalizeVaccine(d.VaccineName)));
            var skippedGroups = FaxGrouping.GroupByPatientAndPrescriber(recordsSkippedAsDuplicate);

            foreach (var skippedGroup in skippedGroups)
            {
                var matchedRunAtUtc = skippedGroup.Records
                    .Select(r => duplicatesByKey.TryGetValue(FaxDuplicateDetector.KeyFor(r), out var d) ? d.PreviouslySentRunAtUtc : (DateTime?)null)
                    .Where(d => d is not null)
                    .Select(d => d!.Value)
                    .DefaultIfEmpty()
                    .Max();
                var dateText = matchedRunAtUtc == default
                    ? "an earlier batch"
                    : matchedRunAtUtc.ToLocalTime().ToString("MM/dd/yyyy");

                summary.SkippedAlreadySent += skippedGroup.Records.Count;
                summary.Rows.Add(new FaxRunRowSummary
                {
                    PatientInitials = skippedGroup.PatientInitials,
                    PrescriberName = skippedGroup.PrescriberName ?? "(unknown prescriber)",
                    Status = $"Skipped — duplicate of {dateText} batch",
                    Error = null,
                });
            }
        }

        var ledgerEntries = _ledger.Load();
        var thisRunEntryIds = new HashSet<string>();
        var outboxDir = Path.Combine(_faxRootDir, "outbox", runDate.ToString("yyyyMMdd"));

        // V-T65 R6: rows actually sent successfully THIS run — recorded to
        // FaxFileLedger at the very end (see below). Never a patient
        // identifier: just the same ImmunizationRecords FaxDuplicateDetector
        // will reduce to (date, vaccine, count) right before persisting.
        var sentSuccessfully = new List<ImmunizationRecord>();

        foreach (var group in groups)
        {
            // Fax-report-layout brief (Will, 2026-09-28), narrowed further
            // by V-T65 (2026-09-29, "One file selector, then send faxes" —
            // no prescriber-fax directory anymore): "rows with an empty
            // prescriber OR empty/invalid fax are skipped silently" — an
            // empty prescriber NAME skips even if the report somehow still
            // had a fax number column value, since the letter's "To:"
            // block needs someone to address it to. The report's own
            // Primary Care Prescriber Fax column is the ONLY source now —
            // no directory fallback.
            var hasPrescriberName = !string.IsNullOrWhiteSpace(group.PrescriberName);
            var resolvedFax = hasPrescriberName
                ? FaxNumberNormalizer.ToDialableOrNull(group.PrescriberFaxFromReport)
                : null;

            if (resolvedFax is null)
            {
                summary.SkippedNoFax++;
                summary.Rows.Add(new FaxRunRowSummary
                {
                    PatientInitials = group.PatientInitials,
                    PrescriberName = group.PrescriberName ?? "(unknown prescriber)",
                    Status = SkippedNoFaxStatus,
                    // Never surfaced as an Error (brief: "not listed as
                    // errors/Needs fax number nags") — the Status text
                    // above already says exactly what happened, in a
                    // neutral colour (see Views/FaxSendWindow.xaml).
                    Error = null,
                });
                continue;
            }

            var entry = new FaxLedgerEntry
            {
                PatientInitials = group.PatientInitials,
                PrescriberName = group.PrescriberName,
                FaxNumber = resolvedFax,
                FaxNumberLast4 = FaxNumberNormalizer.Last4(resolvedFax),
                QueuedAtUtc = DateTime.UtcNow,
                Status = FaxLedgerStatus.Queued,
            };
            thisRunEntryIds.Add(entry.Id);

            byte[] pdfBytes;
            try
            {
                pdfBytes = _pdfBuilder.Build(group, settings, resolvedFax).PdfBytes;
            }
            catch (Exception ex)
            {
                entry.Status = FaxLedgerStatus.Failed;
                entry.Error = $"Couldn't build PDF: {ex.Message}";
                ledgerEntries.Add(entry);
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
            // V-T65 R6 (Will, verbatim: "record the run in the ledger only
            // for rows actually sent successfully"): a vendor-side QUEUE
            // failure (this branch) never counts — re-uploading the same
            // report (e.g. after correcting the prescriber's fax number)
            // must see these rows as new, not duplicates.
            if (entry.Status != FaxLedgerStatus.Failed)
            {
                sentSuccessfully.AddRange(group.Records);
            }

            AppFileLog.Log($"[FaxRunOrchestrator] {entry.PatientInitials} -> {entry.PrescriberName ?? "?"} ({entry.FaxNumberLast4}): {entry.Status}");
        }

        _ledger.Save(ledgerEntries);

        // V-T65: no input folder / processed\ subfolder anymore — the
        // picked report file is left exactly where Will selected it from
        // (see MainWindow's file picker).

        // A second poll pass right after queuing — a nicer first-look
        // summary if SRFax resolves a fast fax immediately; the
        // receipt-poll timer is what carries the rest of the way to
        // Sent/Failed (see FaxRunScheduler).
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
                FaxNumberLast4 = entry.FaxNumberLast4,
                Status = entry.Status.ToString(),
                Error = entry.Error,
                LedgerEntryId = entry.Id,
            });
        }

        // V-T65 R6: record THIS run's (date, vaccine, count) entries — only
        // for rows actually sent successfully (see sentSuccessfully above).
        // A no-op when it's empty (FaxFileLedger.RecordRun's own guard).
        _fileLedger.RecordRun(runAtUtc, FaxDuplicateDetector.Summarize(sentSuccessfully));

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
