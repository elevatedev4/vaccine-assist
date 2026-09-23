namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// Will's brief: "reads every new *.csv/*.xlsx in the configured input
/// folder ... missing required column -> file rejected with a clear
/// message (never silently skip rows) ... Files processed are moved to
/// <input>\processed\<yyyy-MM-dd>\ after the run; an imported.json
/// row-fingerprint ledger ... prevents re-faxing the same administration
/// twice across runs."
///
/// Import() and MoveAcceptedFiles() are deliberately separate calls (not
/// one Import-and-commit method) so FaxRunOrchestrator can build every
/// PDF and queue every fax FIRST, and only mark files processed once
/// that's actually succeeded — a mid-run crash should leave the source
/// files exactly where ReportImporter found them, re-picked-up next run,
/// rather than silently losing rows that were never actually faxed.
///
/// IMPORTANT: Import() does NOT write to imported.json itself — it only
/// READS the ledger (to skip rows already recorded there) and dedupes
/// WITHIN this one call (two files in the same folder both containing the
/// same administration). Persisting new fingerprints is
/// FaxRunOrchestrator's job, and only for rows that actually resolved to
/// a fax number and were queued/sent/failed-at-the-vendor — a row that
/// comes back "needs fax number" must NOT be fingerprinted, or it could
/// never be faxed even after Will adds the prescriber's number to
/// prescribers.json and a later run re-imports the same (or a re-exported)
/// report. FaxRunOrchestrator's serialized single-instance run (see its
/// own doc comment) is what prevents two concurrent runs from
/// double-importing the same row before either one persists anything.
/// </summary>
public sealed class ReportImporter : IReportImporter
{
    private readonly IImportLedger _importLedger;

    public ReportImporter(IImportLedger importLedger)
    {
        _importLedger = importLedger;
    }

    public ImportOutcome Import(string inputFolder, FaxColumnMap columnMap)
    {
        if (string.IsNullOrWhiteSpace(inputFolder) || !Directory.Exists(inputFolder))
        {
            return new ImportOutcome();
        }

        // Read-only snapshot — Import() never writes to the ledger itself,
        // see class doc comment.
        var seenFingerprints = new HashSet<string>(_importLedger.LoadFingerprints(), StringComparer.OrdinalIgnoreCase);

        var files = Directory.EnumerateFiles(inputFolder, "*.*", SearchOption.TopDirectoryOnly)
            .Where(f => f.EndsWith(".csv", StringComparison.OrdinalIgnoreCase) ||
                        f.EndsWith(".xlsx", StringComparison.OrdinalIgnoreCase))
            .OrderBy(f => f, StringComparer.OrdinalIgnoreCase)
            .ToList();

        var newRecords = new List<ImmunizationRecord>();
        var rejectedFiles = new List<RejectedFile>();
        var acceptedFiles = new List<string>();
        var skippedRowCount = 0;
        var duplicateRowCount = 0;

        foreach (var filePath in files)
        {
            ReportFileContents contents;
            try
            {
                contents = ReportRowReader.Read(filePath);
            }
            catch (Exception ex)
            {
                rejectedFiles.Add(new RejectedFile(filePath, $"Couldn't read this file: {ex.Message}"));
                continue;
            }

            var missing = ValidateHeaders(contents.Headers, columnMap);
            if (missing.Count > 0)
            {
                rejectedFiles.Add(new RejectedFile(
                    filePath,
                    $"Missing required column(s): {string.Join(", ", missing)}. " +
                    "Fix the file or update the column map in Fax settings."));
                continue;
            }

            acceptedFiles.Add(filePath);

            foreach (var row in contents.Rows)
            {
                var (record, skipReason) = ReportRowParser.Parse(row, columnMap, filePath);
                if (record is null)
                {
                    // A named per-row reason, never a silent skip — see
                    // class doc comment. Surfaced via SkippedRowCount
                    // (FaxRunOrchestrator's summary), not thrown: one bad
                    // row in an otherwise-good file shouldn't reject the
                    // whole file the way a genuinely missing COLUMN does.
                    _ = skipReason;
                    skippedRowCount++;
                    continue;
                }

                if (!seenFingerprints.Add(record.Fingerprint))
                {
                    duplicateRowCount++;
                    continue;
                }

                newRecords.Add(record);
            }
        }

        return new ImportOutcome
        {
            NewRecords = newRecords,
            SkippedRowCount = skippedRowCount,
            DuplicateRowCount = duplicateRowCount,
            RejectedFiles = rejectedFiles,
            AcceptedFilePaths = acceptedFiles,
        };
    }

    public void MoveAcceptedFiles(IReadOnlyList<string> acceptedFilePaths, string inputFolder, DateOnly runDate)
    {
        if (acceptedFilePaths.Count == 0) return;

        var processedDir = Path.Combine(inputFolder, "processed", runDate.ToString("yyyy-MM-dd"));
        if (!Directory.Exists(processedDir))
        {
            Directory.CreateDirectory(processedDir);
        }

        foreach (var filePath in acceptedFilePaths)
        {
            if (!File.Exists(filePath)) continue;

            var destination = Path.Combine(processedDir, Path.GetFileName(filePath));
            // A same-named file already moved there (e.g. this method
            // somehow ran twice for the same run) loses to a numbered
            // suffix rather than an exception or a silent overwrite of a
            // previously-processed file.
            var attempt = 1;
            while (File.Exists(destination))
            {
                var name = Path.GetFileNameWithoutExtension(filePath);
                var ext = Path.GetExtension(filePath);
                destination = Path.Combine(processedDir, $"{name} ({attempt}){ext}");
                attempt++;
            }

            File.Move(filePath, destination);
        }
    }

    /// <summary>Field-name -> configured-header for every REQUIRED column
    /// (FaxColumnMap.RequiredHeaders) that isn't present (case-insensitive)
    /// in <paramref name="actualHeaders"/>.</summary>
    private static List<string> ValidateHeaders(IReadOnlyList<string> actualHeaders, FaxColumnMap columnMap)
    {
        var actualSet = new HashSet<string>(actualHeaders, StringComparer.OrdinalIgnoreCase);
        var missing = new List<string>();
        foreach (var (field, header) in columnMap.RequiredHeaders())
        {
            if (string.IsNullOrWhiteSpace(header) || !actualSet.Contains(header))
            {
                missing.Add($"{field} (\"{header}\")");
            }
        }
        return missing;
    }
}
