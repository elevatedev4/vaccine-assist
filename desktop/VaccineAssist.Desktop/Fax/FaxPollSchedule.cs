namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// Pure per-entry polling cadence — V-T65 R5 (Will, verbatim, 2026-09-29):
/// "it still shows status 'InProcess' in the app. Need to make sure this
/// stuff updates." Split out of FaxReceiptPoller so the backoff/give-up
/// math is directly unit-testable with plain DateTime values, no ledger/
/// IFaxClient involved (same "pure logic separately testable" convention
/// as FaxGrouping/RowFingerprint).
///
/// Schedule: check every 15s for the first 5 minutes after queuing, then
/// back off to every 60s, and give up entirely 2 hours after queuing
/// (FaxReceiptPoller marks the entry FaxLedgerStatus.Unknown at that
/// point rather than polling forever).
/// </summary>
public static class FaxPollSchedule
{
    public static readonly TimeSpan FastInterval = TimeSpan.FromSeconds(15);
    public static readonly TimeSpan SlowInterval = TimeSpan.FromSeconds(60);
    public static readonly TimeSpan BackoffAfter = TimeSpan.FromMinutes(5);
    public static readonly TimeSpan GiveUpAfter = TimeSpan.FromHours(2);

    /// <summary>True once <paramref name="nowUtc"/> is 2+ hours past
    /// <paramref name="queuedAtUtc"/> — FaxReceiptPoller stops checking
    /// this entry and marks it Unknown instead.</summary>
    public static bool HasExpired(DateTime queuedAtUtc, DateTime nowUtc) =>
        nowUtc - queuedAtUtc >= GiveUpAfter;

    /// <summary>True when enough time has passed since this entry was last
    /// checked that FaxReceiptPoller should call GetStatusAsync for it
    /// again THIS pass — 15s while the fax is under 5 minutes old, 60s
    /// after that. A never-checked entry (lastCheckedAtUtc is null — a
    /// fax that was JUST queued) is always due immediately: it must not
    /// wait out a fresh interval before its very first check, which is
    /// exactly what lets a fast-resolving fax (Will's report: "Received it
    /// perfectly" almost immediately) show up right away instead of up to
    /// 15s later. Callers are expected to have already ruled out
    /// HasExpired.</summary>
    public static bool IsDue(DateTime queuedAtUtc, DateTime? lastCheckedAtUtc, DateTime nowUtc)
    {
        if (lastCheckedAtUtc is null) return true;

        var age = nowUtc - queuedAtUtc;
        var interval = age < BackoffAfter ? FastInterval : SlowInterval;
        return nowUtc - lastCheckedAtUtc.Value >= interval;
    }
}
