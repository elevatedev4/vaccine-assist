namespace VaccineAssist.Desktop.Fax;

/// <summary>One rejected report file — Will's brief: "missing required
/// column -> file rejected with a clear message (never silently skip
/// rows)."</summary>
public sealed record RejectedFile(string FilePath, string Reason);

/// <summary>Result of one ReportImporter.Import call across every
/// *.csv/*.xlsx currently in the input folder.</summary>
public sealed class ImportOutcome
{
    /// <summary>Every NEW (not already in imported.json) row from every
    /// accepted file — already what FaxGrouping should be called on.</summary>
    public IReadOnlyList<ImmunizationRecord> NewRecords { get; init; } = Array.Empty<ImmunizationRecord>();

    /// <summary>Rows skipped within an otherwise-accepted file because
    /// this SPECIFIC row was missing a required value or had an
    /// unparsable date — distinct from RejectedFiles (a whole file
    /// rejected for missing a required COLUMN).</summary>
    public int SkippedRowCount { get; init; }

    /// <summary>Rows present in an accepted file but already seen in a
    /// prior run (imported.json fingerprint match) — not re-included in
    /// NewRecords, not an error.</summary>
    public int DuplicateRowCount { get; init; }

    public IReadOnlyList<RejectedFile> RejectedFiles { get; init; } = Array.Empty<RejectedFile>();

    /// <summary>Every file that was actually read (accepted or rejected) —
    /// FaxRunOrchestrator moves the ACCEPTED ones to processed\<date>\
    /// after the whole run succeeds; rejected files are left in place so
    /// re-running after fixing the column map/report picks them up.</summary>
    public IReadOnlyList<string> AcceptedFilePaths { get; init; } = Array.Empty<string>();
}
