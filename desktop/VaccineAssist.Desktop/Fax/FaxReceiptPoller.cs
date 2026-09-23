using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// Will's brief: "A receipt poller checks 'In Process' entries every 10
/// min (and at the start of each run) until Sent/Failed. Sent PDFs move
/// to fax\sent\, failed to fax\failed\." Pure orchestration over
/// IFaxClient/IFaxLedger — FaxRunScheduler owns the actual 10-minute
/// DispatcherTimer; this class just does one poll pass when asked.
/// </summary>
public sealed class FaxReceiptPoller
{
    private readonly IFaxLedger _ledger;
    private readonly IFaxClient _faxClient;

    public FaxReceiptPoller(IFaxLedger ledger, IFaxClient faxClient)
    {
        _ledger = ledger;
        _faxClient = faxClient;
    }

    /// <summary>Checks every ledger entry currently Queued/InProcess with a
    /// FaxId, updates its status, and moves its PDF to fax\sent\ or
    /// fax\failed\ on a terminal transition. Returns how many entries
    /// transitioned to a terminal state (Sent or Failed) this pass.</summary>
    public async Task<int> PollAsync(CancellationToken ct = default)
    {
        var entries = _ledger.Load();
        var pending = entries.Where(e =>
            (e.Status == FaxLedgerStatus.Queued || e.Status == FaxLedgerStatus.InProcess) &&
            !string.IsNullOrWhiteSpace(e.FaxId)).ToList();

        if (pending.Count == 0) return 0;

        var transitioned = 0;
        foreach (var entry in pending)
        {
            FaxStatusResult result;
            try
            {
                result = await _faxClient.GetStatusAsync(entry.FaxId!, ct);
            }
            catch (Exception ex)
            {
                AppFileLog.LogException("FaxReceiptPoller", ex);
                continue;
            }

            entry.LastCheckedAtUtc = DateTime.UtcNow;

            if (!result.Success)
            {
                // A failed STATUS CHECK (network hiccup, vendor 5xx after
                // retries) is not the same as the fax itself failing —
                // leave the entry Queued/InProcess and try again next
                // pass rather than marking it Failed on a check we
                // couldn't even complete.
                AppFileLog.Log($"[FaxReceiptPoller] status check failed for {entry.Id}: {result.ErrorMessage}");
                continue;
            }

            switch (result.Status)
            {
                case FaxSendStatus.Sent:
                    entry.Status = FaxLedgerStatus.Sent;
                    entry.Error = null;
                    MovePdf(entry, "sent");
                    transitioned++;
                    break;
                case FaxSendStatus.Failed:
                    entry.Status = FaxLedgerStatus.Failed;
                    entry.Error = result.ErrorMessage;
                    MovePdf(entry, "failed");
                    transitioned++;
                    break;
                case FaxSendStatus.InProcess:
                    entry.Status = FaxLedgerStatus.InProcess;
                    break;
                case FaxSendStatus.Queued:
                default:
                    // Stays as-is — nothing terminal happened yet.
                    break;
            }
        }

        _ledger.Save(entries);
        return transitioned;
    }

    private static void MovePdf(FaxLedgerEntry entry, string subfolder) =>
        FaxOutboxPaths.MoveToTerminalFolder(entry, subfolder);
}
