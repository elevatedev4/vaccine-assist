namespace VaccineAssist.Desktop.Fax;

/// <summary>One row of a FaxRunSummary's grid — never a patient's full
/// name (PatientInitials only, matching the ledger/log convention).</summary>
public sealed class FaxRunRowSummary
{
    public string PatientInitials { get; set; } = "";
    public string PrescriberName { get; set; } = "";

    /// <summary>Last 4 digits of the fax number this row was (or would
    /// have been) sent to — blank for a "Skipped (no prescriber fax)" row,
    /// since there is none (fax-report-layout brief, 2026-09-28).</summary>
    public string FaxNumberLast4 { get; set; } = "";

    public string Status { get; set; } = ""; // FaxLedgerStatus.ToString(), or FaxRunOrchestrator.SkippedNoFaxStatus
    public string? Error { get; set; }
    public string LedgerEntryId { get; set; } = "";
}

/// <summary>
/// Will's brief: "write runs\<timestamp>.json summary and show
/// [a results window] (counts: imported rows, patients, sent, in-process,
/// failed, needs-fax-number, with a per-row grid)." Written verbatim to
/// %LocalAppData%\VaccineAssist\fax\runs\<timestamp>.json by
/// FaxRunOrchestrator and bound directly by Views/FaxSendWindow.xaml
/// (V-T65 R4 — replaces the old standalone FaxRunSummaryWindow).
/// </summary>
public sealed class FaxRunSummary
{
    public DateTime RunAtUtc { get; set; }

    /// <summary>File NAME only (never a full path) — V-T65 R5's Send
    /// History section (Views/FaxSendWindow.xaml) lists past batches by
    /// this + RunAtUtc.</summary>
    public string FileName { get; set; } = "";

    /// <summary>SHA-256 hex of the picked file's raw bytes — see
    /// FaxFileHasher/FaxFileLedger. Blank when the file couldn't be read
    /// at all (the import step right after will surface that as a
    /// RejectedFiles entry).</summary>
    public string FileHash { get; set; } = "";

    /// <summary>Set instead of running the pipeline at all when
    /// FaxRunOrchestrator determines every row in this exact file (by
    /// FileHash) has already been fully sent — V-T65 R5 (Will, verbatim:
    /// "make sure that things don't get re-sent if somebody reuploads the
    /// same file"). Every count below stays zero on this path.</summary>
    public string? AlreadySentMessage { get; set; }

    public int RowsImported { get; set; }
    public int SkippedRows { get; set; }
    public int DuplicateRows { get; set; }
    public int PatientsProcessed { get; set; }

    public int Sent { get; set; }
    public int InProcess { get; set; }
    public int Failed { get; set; }

    /// <summary>Rows skipped because the prescriber name and/or a usable
    /// fax number couldn't be resolved (fax-report-layout brief,
    /// 2026-09-28: "Skipped (no prescriber fax)" — never counted as a
    /// failure, and never nagged as an error in the per-row grid).</summary>
    public int SkippedNoFax { get; set; }

    /// <summary>Patient/prescriber groups skipped because every row in the
    /// group already has a Sent/InProcess/Queued ledger entry — V-T65 R5,
    /// shown per-row as "Skipped — already sent &lt;date&gt;" rather than
    /// silently dropped (see ImportOutcome.DuplicateRecords).</summary>
    public int SkippedAlreadySent { get; set; }

    public List<FaxRunRowSummary> Rows { get; set; } = new();

    public List<string> RejectedFiles { get; set; } = new();

    /// <summary>Non-fatal problems the run hit but recovered from (still
    /// produced a full summary/RunCompleted) — e.g. a locked source report
    /// file that couldn't be moved to processed\ after faxes were already
    /// queued (reviewer fix, V-T53). Distinct from RejectedFiles, which
    /// means a whole file was never imported.</summary>
    public List<string> Warnings { get; set; } = new();
}
