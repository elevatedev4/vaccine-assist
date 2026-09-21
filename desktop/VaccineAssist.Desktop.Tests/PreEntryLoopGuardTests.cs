using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using VaccineAssist.Desktop.Uia;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// PreEntryLoopGuard — V-T41 ROUND 3's hard circuit breaker (Will's brief,
/// point 2): "a given dialog kind (e.g. Priority) handled more than 2
/// times in one run, or more than 3 Escapes total, -> stop." See
/// SendF3AndDismissPreEntryDialogsStep's class doc comment (ROUND 3
/// section) for why RunCombinedPreEntryLoopAsync's own maxEmptyTicks
/// budget doesn't already catch a run that keeps "successfully" handling
/// the same recurring dialog/window.
/// </summary>
public class PreEntryLoopGuardTests
{
    [Fact]
    public void RecordHandledDoesNotTripOnTheFirstOrSecondHandlingOfTheSameKind()
    {
        var guard = new PreEntryLoopGuard();

        Assert.False(guard.RecordHandled(DialogKind.Priority));
        Assert.False(guard.RecordHandled(DialogKind.Priority));
        Assert.Equal(2, guard.HandledCount(DialogKind.Priority));
    }

    [Fact]
    public void RecordHandledTripsOnTheThirdHandlingOfTheSameKind()
    {
        var guard = new PreEntryLoopGuard();

        Assert.False(guard.RecordHandled(DialogKind.Priority));
        Assert.False(guard.RecordHandled(DialogKind.Priority));
        Assert.True(guard.RecordHandled(DialogKind.Priority)); // 3rd handling > MaxHandledPerDialogKind (2)
    }

    [Fact]
    public void RecordHandledCountsEachDialogKindIndependently()
    {
        var guard = new PreEntryLoopGuard();

        guard.RecordHandled(DialogKind.Priority);
        guard.RecordHandled(DialogKind.Priority);
        // Priority is now at its trip threshold (2), but a DIFFERENT kind
        // must start from zero — one kind spinning must not falsely trip
        // an unrelated kind.
        Assert.False(guard.RecordHandled(DialogKind.ScanHardCopy));
        Assert.Equal(1, guard.HandledCount(DialogKind.ScanHardCopy));
        Assert.Equal(2, guard.HandledCount(DialogKind.Priority));
    }

    [Fact]
    public void RecordEscapeDoesNotTripForTheFirstThreeEscapes()
    {
        var guard = new PreEntryLoopGuard();

        Assert.False(guard.RecordEscape());
        Assert.False(guard.RecordEscape());
        Assert.False(guard.RecordEscape());
        Assert.Equal(3, guard.TotalEscapes);
    }

    [Fact]
    public void RecordEscapeTripsOnTheFourthEscape()
    {
        var guard = new PreEntryLoopGuard();

        guard.RecordEscape();
        guard.RecordEscape();
        guard.RecordEscape();
        Assert.True(guard.RecordEscape()); // 4th escape > MaxTotalEscapes (3)
    }

    [Fact]
    public void RecordEscapeCountsAcrossDifferentDialogKindsCumulatively()
    {
        // Unlike RecordHandled (per-kind), total escapes are a single
        // run-wide budget regardless of which window each Escape targeted
        // — three different unrecognized windows Escaped once each still
        // trips the SAME counter as one window Escaped three times.
        var guard = new PreEntryLoopGuard();

        guard.RecordEscape();
        guard.RecordEscape();
        guard.RecordEscape();
        Assert.True(guard.RecordEscape());
        Assert.Equal(4, guard.TotalEscapes);
    }

    [Fact]
    public void ANewGuardStartsAtZeroForEveryKindAndForEscapes()
    {
        var guard = new PreEntryLoopGuard();

        Assert.Equal(0, guard.HandledCount(DialogKind.Priority));
        Assert.Equal(0, guard.HandledCount(DialogKind.Unknown));
        Assert.Equal(0, guard.TotalEscapes);
    }
}
