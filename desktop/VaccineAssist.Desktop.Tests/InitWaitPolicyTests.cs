using System;
using VaccineAssist.Desktop.Services;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Pins the InitWaitPolicy timing constants backing CloudPageView's
/// WebView2 init wait (Will, 2026-09-16 timeout fix) so a future
/// accidental regression — e.g. back toward the old 12s cap — fails a
/// test, not just a live report from Will's PC.
///
/// REVIEW FIX (2026-09-16, non-blocking): this used to also test an
/// Evaluate(elapsed) boundary function, removed from InitWaitPolicy as
/// dead code (CloudPageView's actual wait is a Task.WhenAny race against
/// two Task.Delay tasks built from these constants directly, never a
/// polled "how much time has passed" check).
/// </summary>
public class InitWaitPolicyTests
{
    [Fact]
    public void TimeoutIsRaisedTo45Seconds()
    {
        Assert.Equal(TimeSpan.FromSeconds(45), InitWaitPolicy.Timeout);
    }

    [Fact]
    public void HintDelayIsThreeSeconds()
    {
        Assert.Equal(TimeSpan.FromSeconds(3), InitWaitPolicy.HintDelay);
    }

    [Fact]
    public void HintDelayIsShorterThanTimeout()
    {
        // The hint has to actually get a chance to show before the
        // timeout fires.
        Assert.True(InitWaitPolicy.HintDelay < InitWaitPolicy.Timeout);
    }
}
