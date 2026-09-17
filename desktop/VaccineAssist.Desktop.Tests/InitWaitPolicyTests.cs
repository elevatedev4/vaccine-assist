using System;
using VaccineAssist.Desktop.Services;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Unit tests for InitWaitPolicy.Evaluate — the pure "show a hint after 3s
/// / give up after 45s" boundary math backing CloudPageView's WebView2
/// init wait (Will, 2026-09-16 timeout fix). No WebView2, WPF, or real
/// timers — just the boundary math, same style as SessionExpiryTests.
/// </summary>
public class InitWaitPolicyTests
{
    [Fact]
    public void KeepsWaitingImmediately()
    {
        Assert.Equal(InitWaitAction.KeepWaiting, InitWaitPolicy.Evaluate(TimeSpan.Zero));
    }

    [Fact]
    public void KeepsWaitingJustBeforeHintDelay()
    {
        var elapsed = InitWaitPolicy.HintDelay - TimeSpan.FromMilliseconds(1);
        Assert.Equal(InitWaitAction.KeepWaiting, InitWaitPolicy.Evaluate(elapsed));
    }

    [Fact]
    public void ShowsHintExactlyAtHintDelay()
    {
        Assert.Equal(InitWaitAction.ShowStartingHint, InitWaitPolicy.Evaluate(InitWaitPolicy.HintDelay));
    }

    [Fact]
    public void ShowsHintBetweenHintDelayAndTimeout()
    {
        var elapsed = InitWaitPolicy.Timeout - TimeSpan.FromSeconds(1);
        Assert.Equal(InitWaitAction.ShowStartingHint, InitWaitPolicy.Evaluate(elapsed));
    }

    [Fact]
    public void TimesOutExactlyAtTimeout()
    {
        Assert.Equal(InitWaitAction.TimedOut, InitWaitPolicy.Evaluate(InitWaitPolicy.Timeout));
    }

    [Fact]
    public void TimesOutWellPastTimeout()
    {
        var elapsed = InitWaitPolicy.Timeout + TimeSpan.FromMinutes(5);
        Assert.Equal(InitWaitAction.TimedOut, InitWaitPolicy.Evaluate(elapsed));
    }

    [Fact]
    public void TimeoutIsRaisedTo45Seconds()
    {
        // Pins the specific value from the brief so a future accidental
        // regression back toward the old 12s cap fails a test, not just a
        // live report from Will's PC.
        Assert.Equal(TimeSpan.FromSeconds(45), InitWaitPolicy.Timeout);
    }

    [Fact]
    public void HintDelayIsThreeSeconds()
    {
        Assert.Equal(TimeSpan.FromSeconds(3), InitWaitPolicy.HintDelay);
    }
}
