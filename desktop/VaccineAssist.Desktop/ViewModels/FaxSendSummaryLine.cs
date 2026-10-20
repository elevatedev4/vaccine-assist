using VaccineAssist.Desktop.Fax;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>
/// Pure text for FaxSendWindow's top-of-results summary line — V-T65 R5
/// (Will, verbatim, 2026-09-29): "the summary should show number in
/// process and then when it is done show the result." Computed fresh from
/// the LIVE Rows collection every time (never from FaxRunSummary's frozen
/// Sent/Failed/InProcess ints, which only reflect the moment RunAsync
/// returned) so it stays correct as FaxSendCoordinator's background
/// refresh mutates row Status values in place. Split out so the exact
/// wording/counting is directly unit-testable with plain
/// FaxRunRowSummary lists, no coordinator/timer involved.
/// </summary>
public static class FaxSendSummaryLine
{
    public static string Compute(IReadOnlyList<FaxRunRowSummary> rows)
    {
        var inProcess = rows.Count(IsInProcess);
        var sent = rows.Count(r => r.Status == nameof(FaxLedgerStatus.Sent));
        var failed = rows.Count(r => r.Status == nameof(FaxLedgerStatus.Failed));
        var skipped = rows.Count(IsSkipped);
        // Reviewer fix (V-T65 R5 REQUEST_CHANGES, 2026-09-29): a row that
        // FaxReceiptPoller gave up on after 2h (FaxLedgerStatus.Unknown)
        // fell into NO bucket before this — the header would read "Done: N
        // sent, N failed" as if it had resolved one way or the other, when
        // it's actually neither.
        var unknown = rows.Count(r => r.Status == nameof(FaxLedgerStatus.Unknown));

        if (inProcess > 0)
        {
            var line = $"{inProcess} in process · {sent} sent · {failed} failed";
            if (skipped > 0) line += $" · {skipped} skipped";
            if (unknown > 0) line += $" · {unknown} unknown";
            return line;
        }

        var done = $"Done: {sent} sent, {failed} failed";
        if (skipped > 0) done += $", {skipped} skipped — duplicate";
        if (unknown > 0) done += $", {unknown} unknown — check Notifyre";
        return done;
    }

    private static bool IsInProcess(FaxRunRowSummary row) =>
        row.Status == nameof(FaxLedgerStatus.InProcess) || row.Status == nameof(FaxLedgerStatus.Queued);

    /// <summary>Only the duplicate-dedupe skip (FaxRunOrchestrator's
    /// "Skipped — duplicate of &lt;date&gt; batch" text) — deliberately excludes
    /// the unrelated, pre-existing "Skipped (no prescriber fax)" status
    /// (no em dash), which has its own separate counter
    /// (FaxRunSummary.SkippedNoFax) and isn't part of this live line.</summary>
    private static bool IsSkipped(FaxRunRowSummary row) =>
        row.Status.StartsWith("Skipped —", StringComparison.Ordinal);
}
