using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// Will's brief: "A receipt poller checks 'In Process' entries every 10
/// min (and at the start of each run) until Sent/Failed. Sent PDFs move
/// to fax\sent\, failed to fax\failed\." Pure orchestration over
/// IFaxClient/IFaxLedger — FaxRunScheduler owns the actual DispatcherTimer;
/// this class just does one poll pass when asked.
///
/// V-T65 R5 (Will, verbatim, 2026-09-29 — "Fax went through. Received it
/// perfectly. But it still shows status 'InProcess' in the app. Need to
/// make sure this stuff updates."): FaxRunScheduler's timer now ticks
/// every 15s (was 10 min) instead of this class checking every pending
/// entry on every tick, each entry's own cadence is gated by
/// FaxPollSchedule (15s while under 5 min old, 60s after that, gives up —
/// FaxLedgerStatus.Unknown — after 2h) so a busy ledger still only makes
/// one GetStatusAsync call per fax roughly as often as the brief asks for,
/// not one per fax every 15s.
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
    /// FaxId that's due for a check (see FaxPollSchedule), updates its
    /// status, and moves its PDF to fax\sent\ or fax\failed\ on a terminal
    /// transition. An entry more than 2h past QueuedAtUtc is marked Unknown
    /// instead of being checked again. Returns how many entries
    /// transitioned to a terminal-or-give-up state (Sent/Failed/Unknown)
    /// this pass.</summary>
    public async Task<int> PollAsync(CancellationToken ct = default)
    {
        var nowUtc = DateTime.UtcNow;
        var entries = _ledger.Load();
        var pending = entries.Where(e =>
            (e.Status == FaxLedgerStatus.Queued || e.Status == FaxLedgerStatus.InProcess) &&
            !string.IsNullOrWhiteSpace(e.FaxId)).ToList();

        if (pending.Count == 0) return 0;

        var transitioned = 0;
        var changed = false;
        foreach (var entry in pending)
        {
            if (FaxPollSchedule.HasExpired(entry.QueuedAtUtc, nowUtc))
            {
                entry.Status = FaxLedgerStatus.Unknown;
                entry.Error = "Unknown — check Notifyre";
                entry.LastCheckedAtUtc = nowUtc;
                transitioned++;
                changed = true;
                AppFileLog.Log($"[FaxReceiptPoller] gave up polling {entry.Id} after 2h — marked Unknown.");
                continue;
            }

            if (!FaxPollSchedule.IsDue(entry.QueuedAtUtc, entry.LastCheckedAtUtc, nowUtc))
            {
                continue; // not due for another check yet — see FaxPollSchedule.
            }

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
            changed = true;

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

        if (changed)
        {
            _ledger.Save(entries);
        }
        return transitioned;
    }

    private static void MovePdf(FaxLedgerEntry entry, string subfolder) =>
        FaxOutboxPaths.MoveToTerminalFolder(entry, subfolder);
}
