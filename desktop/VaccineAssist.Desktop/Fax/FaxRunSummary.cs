namespace VaccineAssist.Desktop.Fax;

/// <summary>One row of a FaxRunSummary's grid — never a patient's full
/// name (PatientInitials only, matching the ledger/log convention).</summary>
public sealed class FaxRunRowSummary
{
    public string PatientInitials { get; set; } = "";
    public string PrescriberName { get; set; } = "";
    public string Status { get; set; } = ""; // FaxLedgerStatus.ToString()
    public string? Error { get; set; }
    public string LedgerEntryId { get; set; } = "";
}

/// <summary>
/// Will's brief: "write runs\<timestamp>.json summary and show
/// FaxRunSummaryWindow (counts: imported rows, patients, sent, in-process,
/// failed, needs-fax-number, with a per-row grid)." Written verbatim to
/// %AppData%\VaccineAssist\fax\runs\<timestamp>.json by FaxRunOrchestrator
/// and bound directly by FaxRunSummaryWindow.
/// </summary>
public sealed class FaxRunSummary
{
    public DateTime RunAtUtc { get; set; }

    public int RowsImported { get; set; }
    public int SkippedRows { get; set; }
    public int DuplicateRows { get; set; }
    public int PatientsProcessed { get; set; }

    public int Sent { get; set; }
    public int InProcess { get; set; }
    public int Failed { get; set; }
    public int NeedsFaxNumber { get; set; }

    public List<FaxRunRowSummary> Rows { get; set; } = new();

    public List<string> RejectedFiles { get; set; } = new();
}
