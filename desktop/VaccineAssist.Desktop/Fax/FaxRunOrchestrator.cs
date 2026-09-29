using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Fax;

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
    private readonly IImportLedger _importLedger;
    private readonly string _faxRootDir;
    private readonly IFaxFileLedger _fileLedger;
    private readonly SemaphoreSlim _runLock = new(1, 1);

    public FaxRunOrchestrator(
        IReportImporter importer,
        IVaccineRecordPdfBuilder pdfBuilder,
        IFaxClient faxClient,
        IFaxLedger ledger,
        IImportLedger importLedger,
        string faxRootDir,
        IFaxFileLedger fileLedger)
    {
        _importer = importer;
        _pdfBuilder = pdfBuilder;
        _faxClient = faxClient;
        _ledger = ledger;
        _importLedger = importLedger;
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

    /// <summary>Runs the full pipeline once against ONE user-picked report
    /// file (V-T65: tray icon -> Views/FaxSendWindow.xaml's file picker,
    /// then this runs only once Will presses Send there — R4, 2026-09-29;
    /// no input folder, no scan). Returns null (a no-op, logged,
    /// never thrown) if a run is already in progress.</summary>
    public async Task<FaxRunSummary?> RunAsync(string reportFilePath, FaxSettings settings, CancellationToken ct = default)
    {
        if (!await _runLock.WaitAsync(0, ct))
        {
            AppFileLog.Log("[FaxRunOrchestrator] Run requested while one is already in progress — skipped.");
            return null;
        }

        try
        {
            return await RunCoreAsync(reportFilePath, settings, ct);
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

    private async Task<FaxRunSummary> RunCoreAsync(string reportFilePath, FaxSettings settings, CancellationToken ct)
    {
        var runAtUtc = DateTime.UtcNow;
        var runDate = DateOnly.FromDateTime(DateTime.Now);
        var fileName = Path.GetFileName(reportFilePath);

        // V-T65 R5 (Will, verbatim, 2026-09-29: "make sure that things
        // don't get re-sent if somebody reuploads the same file"). Hashed
        // BEFORE the import/PDF/send pipeline runs at all, so a re-upload
        // of an already-fully-sent file short-circuits with a clear
        // message instead of silently no-op'ing through the whole pipeline
        // (the per-row fingerprint dedupe below would ALSO catch it, but
        // only after building/attempting a PDF per row — this is a fast,
        // friendly early exit, not the actual safety gate).
        string fileHash;
        try
        {
            var fileBytes = await File.ReadAllBytesAsync(reportFilePath, ct);
            fileHash = FaxFileHasher.ComputeHex(fileBytes);
        }
        catch (Exception ex)
        {
            // Couldn't even read the file to hash it — leave fileHash
            // blank and let the normal import step below surface a clear
            // RejectedFiles reason (it hits the exact same File I/O).
            fileHash = "";
            AppFileLog.LogException("FaxRunOrchestrator.HashFile", ex);
        }

        if (!string.IsNullOrEmpty(fileHash))
        {
            var alreadySentAt = CheckAlreadyFullySent(fileHash);
            if (alreadySentAt is not null)
            {
                var skipSummary = new FaxRunSummary
                {
                    RunAtUtc = runAtUtc,
                    FileName = fileName,
                    FileHash = fileHash,
                    AlreadySentMessage =
                        $"{fileName} was already fully sent on {alreadySentAt.Value.ToLocalTime():MM/dd/yyyy h:mm tt} — nothing to send. " +
                        "Choose a different file, or check Send history below.",
                };
                WriteRunSummaryFile(skipSummary);
                AppFileLog.Log($"[FaxRunOrchestrator] {fileName} already fully sent — skipped re-processing.");
                return skipSummary;
            }
        }

        var poller = new FaxReceiptPoller(_ledger, _faxClient);

        // Brief: "A receipt poller checks 'In Process' entries ... at the
        // start of each run."
        await poller.PollAsync(ct);

        var importOutcome = _importer.ImportFile(reportFilePath, settings.ColumnMap);
        var groups = FaxGrouping.GroupByPatientAndPrescriber(importOutcome.NewRecords);

        var summary = new FaxRunSummary
        {
            RunAtUtc = runAtUtc,
            FileName = fileName,
            FileHash = fileHash,
            RowsImported = importOutcome.NewRecords.Count,
            SkippedRows = importOutcome.SkippedRowCount,
            DuplicateRows = importOutcome.DuplicateRowCount,
            PatientsProcessed = groups.Count,
            RejectedFiles = importOutcome.RejectedFiles
                .Select(f => $"{Path.GetFileName(f.FilePath)}: {f.Reason}")
                .ToList(),
        };

        var ledgerEntries = _ledger.Load();

        // V-T65 R5: duplicate rows (already-fingerprinted administrations)
        // are shown, not silently dropped — grouped the same way real
        // sends are, matched back to whichever ledger entry already covers
        // them for a "since <date>" the group can display.
        if (importOutcome.DuplicateRecords.Count > 0)
        {
            var duplicateGroups = FaxGrouping.GroupByPatientAndPrescriber(importOutcome.DuplicateRecords);
            foreach (var dupGroup in duplicateGroups)
            {
                var groupFingerprints = new HashSet<string>(dupGroup.Records.Select(r => r.Fingerprint));
                var match = ledgerEntries.FirstOrDefault(e => e.RowFingerprints.Any(fp => groupFingerprints.Contains(fp)));
                var dateText = match is not null
                    ? match.QueuedAtUtc.ToLocalTime().ToString("MM/dd/yyyy")
                    : "an earlier date";

                summary.SkippedAlreadySent++;
                summary.Rows.Add(new FaxRunRowSummary
                {
                    PatientInitials = dupGroup.PatientInitials,
                    PrescriberName = dupGroup.PrescriberName ?? "(unknown prescriber)",
                    FaxNumberLast4 = match?.FaxNumberLast4 ?? "",
                    Status = $"Skipped — already sent {dateText}",
                    Error = null,
                    LedgerEntryId = match?.Id ?? "",
                });
            }
        }

        var newFingerprints = new List<string>();
        var thisRunEntryIds = new HashSet<string>();
        var outboxDir = Path.Combine(_faxRootDir, "outbox", runDate.ToString("yyyyMMdd"));

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
            // Fingerprinted once queued (or Sent) — never for a
            // skipped-no-fax group, see above. V-T65 R5 (Will, verbatim:
            // "failed ones are retried"): a vendor-side QUEUE failure
            // (this branch) is deliberately NOT fingerprinted, so
            // re-uploading the same report (e.g. after correcting the
            // prescriber's fax number) picks the row back up as new
            // instead of it being stuck "already sent" forever with no
            // way back in except the manual Retry button. This is
            // unrelated to the PDF-build-failure branch above, which IS
            // still always fingerprinted — that failure is a template/
            // code problem a resend can't fix, and RetryFailedAsync can't
            // retry it either (no PdfPath was ever written).
            if (entry.Status != FaxLedgerStatus.Failed)
            {
                newFingerprints.AddRange(entry.RowFingerprints);
            }

            AppFileLog.Log($"[FaxRunOrchestrator] {entry.PatientInitials} -> {entry.PrescriberName ?? "?"} ({entry.FaxNumberLast4}): {entry.Status}");
        }

        _ledger.Save(ledgerEntries);
        if (newFingerprints.Count > 0)
        {
            _importLedger.AddFingerprints(newFingerprints);
        }

        // V-T65 R5: records this file's hash against every row it
        // actually contributed this run, so a later byte-identical
        // re-upload can be recognized (see CheckAlreadyFullySent) once
        // those rows finish resolving to Sent. Skipped when the file
        // produced nothing new (fileHash blank, or every row was a
        // duplicate/no-fax skip) — nothing to remember either way.
        if (!string.IsNullOrEmpty(fileHash) && importOutcome.NewRecords.Count > 0)
        {
            _fileLedger.Record(fileHash, fileName, importOutcome.NewRecords.Select(r => r.Fingerprint));
        }

        // V-T65: no input folder / processed\ subfolder anymore — the
        // picked report file is left exactly where Will selected it from
        // (see MainWindow's file picker); the fingerprint ledger above is
        // what stops the same administration being re-faxed if he
        // re-imports the same file.

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

        WriteRunSummaryFile(summary);
        return summary;
    }

    /// <summary>V-T65 R5: returns when this file was last recorded (see
    /// FaxFileLedger.Record) IF every row fingerprint it's ever
    /// contributed is currently covered by a Sent ledger entry — null
    /// otherwise (never recorded, or something in it is still
    /// pending/failed and genuinely needs processing). Re-derives "Sent"
    /// live from the CURRENT ledger rather than trusting a stale flag, so
    /// a file that was InProcess yesterday and finished Sent overnight is
    /// recognized correctly today.</summary>
    private DateTime? CheckAlreadyFullySent(string fileHash)
    {
        var fileEntries = _fileLedger.Load();
        var match = fileEntries.FirstOrDefault(e => string.Equals(e.FileHash, fileHash, StringComparison.OrdinalIgnoreCase));
        if (match is null || match.RowFingerprints.Count == 0)
        {
            return null;
        }

        var sentFingerprints = new HashSet<string>(
            _ledger.Load()
                .Where(e => e.Status == FaxLedgerStatus.Sent)
                .SelectMany(e => e.RowFingerprints),
            StringComparer.OrdinalIgnoreCase);

        return match.RowFingerprints.All(fp => sentFingerprints.Contains(fp))
            ? match.RecordedAtUtc
            : null;
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
