namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// V-T65 (Will's brief, 2026-09-29 — replaces the old folder-scanning
/// pipeline): "One file selector, then send faxes." ImportFile reads the
/// ONE report file Will picked — missing required column -> file rejected
/// with a clear message (never silently skip rows).
///
/// V-T65 R6 (Will, verbatim, 2026-09-29: "we can't store patient name" —
/// read to mean no patient-derived data at all, even hashed): this used to
/// also dedupe rows against a cross-run fingerprint ledger
/// (imported.json/ImportLedger, keyed by a SHA-256 of patient name+DOB+
/// vaccine+lot+date). That ledger stored patient-derived hashes forever,
/// which is exactly what Will's brief rules out — removed entirely, along
/// with RowFingerprint.cs/ImportLedger.cs/IImportLedger.cs. ImportFile now
/// just parses every row it can; duplicate detection is a (date, vaccine,
/// count) check FaxRunOrchestrator runs against FaxFileLedger instead (see
/// FaxDuplicateDetector) — patient-data-free by construction.
/// </summary>
public sealed class ReportImporter : IReportImporter
{
    public ImportOutcome ImportFile(string filePath, FaxColumnMap columnMap)
    {
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

            newRecords.Add(record);
        }

        return new ImportOutcome
        {
            NewRecords = newRecords,
            SkippedRowCount = skippedRowCount,
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
