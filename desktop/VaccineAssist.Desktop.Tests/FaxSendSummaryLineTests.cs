using System.Collections.Generic;
using VaccineAssist.Desktop.Fax;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>V-T65 R5 (Will, verbatim, 2026-09-29): "the summary should
/// show number in process and then when it is done show the result."</summary>
public class FaxSendSummaryLineTests
{
    private static FaxRunRowSummary Row(string status) => new() { Status = status };

    [Fact]
    public void EmptyRowsReadsDoneWithZeroes()
    {
        Assert.Equal("Done: 0 sent, 0 failed", FaxSendSummaryLine.Compute(new List<FaxRunRowSummary>()));
    }

    [Fact]
    public void AnyInProcessRowShowsTheLiveCountFormat()
    {
        var rows = new List<FaxRunRowSummary>
        {
            Row(nameof(FaxLedgerStatus.InProcess)),
            Row(nameof(FaxLedgerStatus.Queued)),
            Row(nameof(FaxLedgerStatus.Sent)),
            Row(nameof(FaxLedgerStatus.Failed)),
        };

        Assert.Equal("2 in process · 1 sent · 1 failed", FaxSendSummaryLine.Compute(rows));
    }

    [Fact]
    public void OnceNothingIsInProcessItReadsDone()
    {
        var rows = new List<FaxRunRowSummary>
        {
            Row(nameof(FaxLedgerStatus.Sent)),
            Row(nameof(FaxLedgerStatus.Sent)),
            Row(nameof(FaxLedgerStatus.Failed)),
        };

        Assert.Equal("Done: 2 sent, 1 failed", FaxSendSummaryLine.Compute(rows));
    }

    [Fact]
    public void SkippedDuplicateRowsAppendToTheInProcessLine()
    {
        var rows = new List<FaxRunRowSummary>
        {
            Row(nameof(FaxLedgerStatus.InProcess)),
            Row("Skipped — duplicate of 09/29/2026 batch"),
        };

        Assert.Equal("1 in process · 0 sent · 0 failed · 1 skipped", FaxSendSummaryLine.Compute(rows));
    }

    [Fact]
    public void SkippedDuplicateRowsAppendToTheDoneLine()
    {
        var rows = new List<FaxRunRowSummary>
        {
            Row(nameof(FaxLedgerStatus.Sent)),
            Row("Skipped — duplicate of 09/29/2026 batch"),
            Row("Skipped — duplicate of 09/28/2026 batch"),
        };

        Assert.Equal("Done: 1 sent, 0 failed, 2 skipped — duplicate", FaxSendSummaryLine.Compute(rows));
    }

    [Fact]
    public void SkippedNoFaxRowsAreNotCountedAsInProcessOrSkippedAlreadySent()
    {
        // "Skipped (no prescriber fax)" is a DIFFERENT status text (no
        // "Skipped —" prefix) — must not inflate either bucket.
        var rows = new List<FaxRunRowSummary> { Row("Skipped (no prescriber fax)") };

        Assert.Equal("Done: 0 sent, 0 failed", FaxSendSummaryLine.Compute(rows));
    }

    // ---- Reviewer fix (V-T65 R5 REQUEST_CHANGES, 2026-09-29): a row that
    // gave up after 2h (FaxLedgerStatus.Unknown) fell into no bucket
    // before this — "Done: N sent, N failed" would read as if everything
    // had resolved one way or the other. ----

    [Fact]
    public void UnknownRowsAppendToTheInProcessLine()
    {
        var rows = new List<FaxRunRowSummary>
        {
            Row(nameof(FaxLedgerStatus.InProcess)),
            Row(nameof(FaxLedgerStatus.Unknown)),
        };

        Assert.Equal("1 in process · 0 sent · 0 failed · 1 unknown", FaxSendSummaryLine.Compute(rows));
    }

    [Fact]
    public void UnknownRowsAppendToTheDoneLine()
    {
        var rows = new List<FaxRunRowSummary>
        {
            Row(nameof(FaxLedgerStatus.Sent)),
            Row(nameof(FaxLedgerStatus.Unknown)),
            Row(nameof(FaxLedgerStatus.Unknown)),
        };

        Assert.Equal("Done: 1 sent, 0 failed, 2 unknown — check Notifyre", FaxSendSummaryLine.Compute(rows));
    }

    [Fact]
    public void SkippedAndUnknownBothAppendToTheDoneLineInOrder()
    {
        var rows = new List<FaxRunRowSummary>
        {
            Row(nameof(FaxLedgerStatus.Sent)),
            Row("Skipped — duplicate of 09/29/2026 batch"),
            Row(nameof(FaxLedgerStatus.Unknown)),
        };

        Assert.Equal(
            "Done: 1 sent, 0 failed, 1 skipped — duplicate, 1 unknown — check Notifyre",
            FaxSendSummaryLine.Compute(rows));
    }
}
