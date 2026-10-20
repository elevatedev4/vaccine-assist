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
        var pending = entries.Where(IsPollable).ToList();

        if (pending.Count == 0) return 0;

        var transitioned = 0;
        var changed = false;
        foreach (var entry in pending)
        {
            if (FaxPollSchedule.HasExpired(entry.QueuedAtUtc, nowUtc))
            {
                if (entry.Status == FaxLedgerStatus.Failed)
                {
                    // A "not found" Failed that never resolved to Sent in 2h
                    // is final: stop re-checking, file the PDF under failed\.
                    entry.NotFoundFailure = false;
                    entry.LastCheckedAtUtc = nowUtc;
                    MovePdf(entry, "failed");
                    changed = true;
                    AppFileLog.Log($"[FaxReceiptPoller] {entry.Id} still not found after 2h — Failed is final.");
                    continue;
                }

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

            // V-T65 (Will, 2026-10-20): Notifyre's sent list lags a fresh
            // submit — "fax id not found" inside the grace window is
            // still in process, never Failed (the first poll, 81 ms after
            // submit, used to map to Failed).
            var inGrace = result.NotFound && FaxPollSchedule.IsWithinNotFoundGrace(entry.QueuedAtUtc, nowUtc);

            // V-T65 R7 (Will, verbatim, 2026-09-30: "It still stays on 'in
            // process' ... never reports back a successful fax. Need to
            // fix that with Notifyre."): one log line per poll result —
            // ledger entry id (not patient data), the vendor's own raw
            // status text, and what this mapped it to — so a stuck entry
            // is diagnosable from app.log alone. No PHI: entry.Id is a
            // random guid, FaxId is Notifyre's own identifier, RawStatus is
            // vendor delivery-status text.
            AppFileLog.Log(
                $"[FaxReceiptPoller] poll {entry.Id} (faxId={entry.FaxId}) — " +
                $"success={result.Success} raw=\"{result.RawStatus ?? "(none)"}\" " +
                $"mapped={(inGrace ? FaxSendStatus.InProcess : result.Status)}" +
                (inGrace ? " (not listed yet, within grace window)" : "") +
                (result.Success ? "" : $" error=\"{result.ErrorMessage}\""));

            if (inGrace)
            {
                continue; // still in process; try again next pass.
            }

            if (!result.Success)
            {
                if (result.NotFound)
                {
                    // Past the grace window and still not listed: Failed with
                    // the existing message, but re-checkable — a later
                    // "successful" overrides it (entry stays pollable).
                    if (entry.Status != FaxLedgerStatus.Failed)
                    {
                        transitioned++;
                    }
                    entry.Status = FaxLedgerStatus.Failed;
                    entry.Error = result.ErrorMessage;
                    entry.NotFoundFailure = true;
                }

                // Any other failed STATUS CHECK (network hiccup, vendor 5xx
                // after retries) is not the fax itself failing — leave the
                // entry as-is and try again next pass.
                continue;
            }

            // A vendor answer overrides a re-checkable "not found" Failed.
            entry.NotFoundFailure = false;
            if (entry.Status == FaxLedgerStatus.Failed && result.Status != FaxSendStatus.Failed)
            {
                entry.Status = FaxLedgerStatus.InProcess;
                entry.Error = null;
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

    /// <summary>Queued/InProcess with a FaxId, plus a Failed entry that is
    /// only Failed because the fax was "not found" (FaxLedgerEntry.
    /// NotFoundFailure) — so a later Sent can still override it.</summary>
    internal static bool IsPollable(FaxLedgerEntry e) =>
        !string.IsNullOrWhiteSpace(e.FaxId) &&
        (e.Status == FaxLedgerStatus.Queued || e.Status == FaxLedgerStatus.InProcess ||
         (e.Status == FaxLedgerStatus.Failed && e.NotFoundFailure));

    private static void MovePdf(FaxLedgerEntry entry, string subfolder) =>
        FaxOutboxPaths.MoveToTerminalFolder(entry, subfolder);
}
