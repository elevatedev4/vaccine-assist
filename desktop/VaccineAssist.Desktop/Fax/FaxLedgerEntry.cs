namespace VaccineAssist.Desktop.Fax;

/// <summary>Ledger-entry lifecycle state — NeedsFaxNumber is a dead end
/// (never sent; shown in the run summary so Will can add the number and
/// re-run) rather than a transition into Queued.</summary>
public enum FaxLedgerStatus
{
    NeedsFaxNumber,
    Queued,
    InProcess,
    Sent,
    Failed,
}

/// <summary>
/// One row of %AppData%\VaccineAssist\fax\ledger.json — Will's brief:
/// "one entry per fax (id, patient initials only + our internal row
/// hashes, prescriber, fax last-4, pdf path, queuedAt, faxDetailsId,
/// status, lastCheckedAt, error)." NEVER a patient's full name or DOB —
/// PatientInitials + RowFingerprints are the only patient-identifying
/// fields, matching AppFileLog's own "initials + last-4 only" rule.
/// </summary>
public sealed class FaxLedgerEntry
{
    public string Id { get; set; } = Guid.NewGuid().ToString("n");

    public string PatientInitials { get; set; } = "";

    /// <summary>ImmunizationRecord.Fingerprint for every row this one fax
    /// covers — lets a failed/retried fax be traced back to its source
    /// rows without ever storing the patient's name here.</summary>
    public List<string> RowFingerprints { get; set; } = new();

    public string? PrescriberName { get; set; }
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
