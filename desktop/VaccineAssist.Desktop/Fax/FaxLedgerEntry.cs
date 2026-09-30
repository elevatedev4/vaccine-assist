namespace VaccineAssist.Desktop.Fax;

/// <summary>Ledger-entry lifecycle state — a group with no usable
/// prescriber fax never becomes a FaxLedgerEntry at all (see
/// FaxRunOrchestrator's skip branch — it's reported directly in the run
/// summary as "Skipped (no prescriber fax)" instead), so every value
/// here really is a real fax's state, never a dead end.</summary>
public enum FaxLedgerStatus
{
    Queued,
    InProcess,
    Sent,
    Failed,

    /// <summary>V-T65 R5 (Will's brief, 2026-09-29): a fax FaxReceiptPoller
    /// gave up polling — never resolved to Sent/Failed within
    /// FaxPollSchedule.GiveUpAfter (2h) of being queued. Never set by a
    /// vendor response; only FaxReceiptPoller.PollAsync sets it, on its own
    /// elapsed-time check. Terminal in the same sense Sent/Failed are (it
    /// drops out of "pending" so polling stops), but distinct so the UI can
    /// say "check Notifyre" instead of implying either outcome.</summary>
    Unknown,
}

/// <summary>
/// One row of %AppData%\VaccineAssist\fax\ledger.json — Will's brief:
/// "one entry per fax (id, patient initials only, prescriber, fax
/// last-4, pdf path, queuedAt, faxDetailsId, status, lastCheckedAt,
/// error)." NEVER a patient's full name or DOB — PatientInitials is the
/// only patient-identifying field, matching AppFileLog's own "initials +
/// last-4 only" rule. V-T65 R6 (Will, verbatim, 2026-09-29: "we can't
/// store patient name" — extended to mean not even a patient-derived
/// hash): this used to also carry RowFingerprints (a SHA-256 of patient
/// name+DOB+vaccine+lot+date per row) for duplicate-detection and Retry
/// bookkeeping — removed entirely, along with RowFingerprint.cs. Retry
/// doesn't need it (PdfPath/FaxNumber are enough — see RetryFailedAsync),
/// and duplicate detection now runs against FaxFileLedger's date/vaccine/
/// count ledger instead (see FaxDuplicateDetector).
/// </summary>
public sealed class FaxLedgerEntry
{
    public string Id { get; set; } = Guid.NewGuid().ToString("n");

    public string PatientInitials { get; set; } = "";

    public string? PrescriberName { get; set; }

    /// <summary>The full dialable (digits-only) fax number this fax was
    /// sent to — needed so Retry (V-T65: the prescriber-fax directory is
    /// gone, the report's own column is the only source) can re-queue
    /// without re-importing the report. Not patient data, so storing the
    /// full number (unlike PatientInitials-only) is fine.</summary>
    public string FaxNumber { get; set; } = "";

    public string FaxNumberLast4 { get; set; } = "";

    public string? PdfPath { get; set; }

    public DateTime QueuedAtUtc { get; set; }

    /// <summary>The vendor's fax id (SRFax: FaxDetailsID) — null until
    /// QueueAsync succeeds.</summary>
    public string? FaxId { get; set; }

    public FaxLedgerStatus Status { get; set; } = FaxLedgerStatus.Queued;

    public DateTime? LastCheckedAtUtc { get; set; }

    public string? Error { get; set; }
}
