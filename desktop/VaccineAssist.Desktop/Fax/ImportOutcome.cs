namespace VaccineAssist.Desktop.Fax;

/// <summary>One rejected report file — Will's brief: "missing required
/// column -> file rejected with a clear message (never silently skip
/// rows)."</summary>
public sealed record RejectedFile(string FilePath, string Reason);

/// <summary>Result of one ReportImporter.ImportFile call against the one
/// user-picked report file (V-T65).</summary>
public sealed class ImportOutcome
{
    /// <summary>Every NEW (not already in imported.json) row from the
    /// accepted file — already what FaxGrouping should be called on.
    /// Empty when the file was rejected (see RejectedFiles).</summary>
    public IReadOnlyList<ImmunizationRecord> NewRecords { get; init; } = Array.Empty<ImmunizationRecord>();

    /// <summary>Rows skipped within an otherwise-accepted file because
    /// this SPECIFIC row was missing a required value or had an
    /// unparsable date — distinct from RejectedFiles (the whole file
    /// rejected for missing a required COLUMN).</summary>
    public int SkippedRowCount { get; init; }

    /// <summary>Rows present in an accepted file but already seen in a
    /// prior run (imported.json fingerprint match) — not re-included in
    /// NewRecords, not an error.</summary>
    public int DuplicateRowCount { get; init; }

    /// <summary>The actual duplicate rows (same count as DuplicateRowCount)
    /// — V-T65 R5 (Will, verbatim, 2026-09-29: "make sure that things don't
    /// get re-sent if somebody reuploads the same file"): FaxRunOrchestrator
    /// groups these and shows "Skipped — already sent &lt;date&gt;" per
    /// patient/prescriber instead of the old silent drop.</summary>
    public IReadOnlyList<ImmunizationRecord> DuplicateRecords { get; init; } = Array.Empty<ImmunizationRecord>();

    /// <summary>Zero (accepted) or one (rejected) entry — kept as a list
    /// so FaxRunSummary.RejectedFiles doesn't need to change shape.</summary>
    public IReadOnlyList<RejectedFile> RejectedFiles { get; init; } = Array.Empty<RejectedFile>();
}
