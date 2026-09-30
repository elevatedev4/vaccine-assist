namespace VaccineAssist.Desktop.Fax;

/// <summary>One rejected report file — Will's brief: "missing required
/// column -> file rejected with a clear message (never silently skip
/// rows)."</summary>
public sealed record RejectedFile(string FilePath, string Reason);

/// <summary>Result of one ReportImporter.ImportFile call against the one
/// user-picked report file (V-T65). V-T65 R6 (Will, verbatim, 2026-09-29:
/// "we can't store patient name" — read to mean no patient-derived data
/// at all, even hashed): ImportFile no longer dedupes rows against a
/// cross-run fingerprint ledger — that whole mechanism (RowFingerprint,
/// ImportLedger/imported.json) is gone. Duplicate detection now happens
/// one layer up, in FaxRunOrchestrator, as a (date, vaccine, count) check
/// against FaxFileLedger — see FaxDuplicateDetector.</summary>
public sealed class ImportOutcome
{
    /// <summary>Every successfully-parsed row from the accepted file —
    /// already what FaxGrouping should be called on. Empty when the file
    /// was rejected (see RejectedFiles).</summary>
    public IReadOnlyList<ImmunizationRecord> NewRecords { get; init; } = Array.Empty<ImmunizationRecord>();

    /// <summary>Rows skipped within an otherwise-accepted file because
    /// this SPECIFIC row was missing a required value or had an
    /// unparsable date — distinct from RejectedFiles (the whole file
    /// rejected for missing a required COLUMN).</summary>
    public int SkippedRowCount { get; init; }

    /// <summary>Zero (accepted) or one (rejected) entry — kept as a list
    /// so FaxRunSummary.RejectedFiles doesn't need to change shape.</summary>
    public IReadOnlyList<RejectedFile> RejectedFiles { get; init; } = Array.Empty<RejectedFile>();
}
