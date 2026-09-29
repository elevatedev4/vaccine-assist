namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// V-T65 (Will's brief, 2026-09-29 — replaces the old folder-scanning
/// pipeline): "One file selector, then send faxes." ImportFile reads the
/// ONE report file Will picked — missing required column -> file rejected
/// with a clear message (never silently skip rows); dedupes against the
/// import ledger's row-fingerprints so re-importing the same (or a
/// re-exported) report never re-faxes the same administration twice.
///
/// IMPORTANT: ImportFile does NOT write to imported.json itself — it only
/// READS the ledger (to skip rows already recorded there). Persisting new
/// fingerprints is FaxRunOrchestrator's job, and only for rows that
/// actually resolved to a fax number and were queued/sent/failed-at-the-
/// vendor — a row that comes back "needs fax number" must NOT be
/// fingerprinted, or it could never be faxed even after the report is
/// corrected and re-imported. FaxRunOrchestrator's serialized single-
/// instance run (see its own doc comment) is what prevents two concurrent
/// runs from double-importing the same row before either one persists
/// anything.
/// </summary>
public sealed class ReportImporter : IReportImporter
{
    private readonly IImportLedger _importLedger;

    public ReportImporter(IImportLedger importLedger)
    {
        _importLedger = importLedger;
    }

    public ImportOutcome ImportFile(string filePath, FaxColumnMap columnMap)
    {
        // Read-only snapshot — ImportFile() never writes to the ledger
        // itself, see class doc comment.
        var seenFingerprints = new HashSet<string>(_importLedger.LoadFingerprints(), StringComparer.OrdinalIgnoreCase);

        ReportFileContents contents;
        try
        {
            contents = ReportRowReader.Read(filePath);
        }
        catch (Exception ex)
        {
            return new ImportOutcome
            {
                RejectedFiles = new List<RejectedFile> { new(filePath, $"Couldn't read this file: {ex.Message}") },
            };
        }

        var missing = ValidateHeaders(contents.Headers, columnMap);
        if (missing.Count > 0)
        {
            return new ImportOutcome
            {
                RejectedFiles = new List<RejectedFile>
                {
                    new(filePath, $"Missing required column(s): {string.Join(", ", missing)}. " +
                        "Fix the file or update the column map in Fax settings."),
                },
            };
        }

        var newRecords = new List<ImmunizationRecord>();
        var duplicateRecords = new List<ImmunizationRecord>();
        var skippedRowCount = 0;

        foreach (var row in contents.Rows)
        {
            var (record, skipReason) = ReportRowParser.Parse(row, columnMap, filePath);
            if (record is null)
            {
                // A named per-row reason, never a silent skip — see class
                // doc comment. Surfaced via SkippedRowCount
                // (FaxRunOrchestrator's summary), not thrown: one bad row
                // in an otherwise-good file shouldn't reject the whole
                // file the way a genuinely missing COLUMN does.
                _ = skipReason;
                skippedRowCount++;
                continue;
            }

            if (!seenFingerprints.Add(record.Fingerprint))
            {
                // V-T65 R5: kept (not just counted) — FaxRunOrchestrator
                // groups these and shows "Skipped — already sent <date>"
                // instead of the row disappearing with no explanation.
                duplicateRecords.Add(record);
                continue;
            }

            newRecords.Add(record);
        }

        return new ImportOutcome
        {
            NewRecords = newRecords,
            SkippedRowCount = skippedRowCount,
            DuplicateRowCount = duplicateRecords.Count,
            DuplicateRecords = duplicateRecords,
        };
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
