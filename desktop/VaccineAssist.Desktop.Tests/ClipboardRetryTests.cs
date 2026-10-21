using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Services;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>A locked clipboard must be retried before a flu swap is treated as failed (wrong product must never be entered). Synthetic text only.</summary>
public class ClipboardRetryTests
{
    private static Task NoWait(TimeSpan _) => Task.CompletedTask;

    [Fact]
    public async Task Succeeds_FirstTry_NoRetry()
    {
        var sets = new List<string>();
        var ok = await ClipboardRetry.TrySetAsync(sets.Add, "code-a", wait: NoWait);
        Assert.True(ok);
        Assert.Equal(new[] { "code-a" }, sets);
    }

    [Fact]
    public async Task RetriesABusyClipboard_ThenSucceeds()
    {
        var calls = 0;
        var failures = new List<int>();
        var ok = await ClipboardRetry.TrySetAsync(
            _ => { calls++; if (calls < 3) throw new InvalidOperationException("busy"); },
            "code-a", wait: NoWait, onFailure: (attempt, _) => failures.Add(attempt));
        Assert.True(ok);
        Assert.Equal(3, calls);
        Assert.Equal(new[] { 1, 2 }, failures);
    }

    [Fact]
    public async Task GivesUpAfterTheLastAttempt_AndNeverThrows()
    {
        var calls = 0;
        var waits = 0;
        var ok = await ClipboardRetry.TrySetAsync(
            _ => { calls++; throw new InvalidOperationException("locked"); },
            "code-a", attempts: 4, wait: _ => { waits++; return Task.CompletedTask; });
        Assert.False(ok);
        Assert.Equal(4, calls);
        Assert.Equal(3, waits); // no wait after the final attempt
    }

    [Fact]
    public async Task AtLeastOneAttemptEvenWhenAttemptsIsZero()
    {
        var calls = 0;
        var ok = await ClipboardRetry.TrySetAsync(_ => calls++, "x", attempts: 0, wait: NoWait);
        Assert.True(ok);
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task Async_StopsWhenTheOneSecondBudgetIsUsedUp()
    {
        // Fake clock: each wait advances it by the pause (50 ms) - never more than ~1 s of waiting in total.
        var now = TimeSpan.Zero;
        var calls = 0;
        var ok = await ClipboardRetry.TrySetAsync(
            _ => { calls++; throw new InvalidOperationException("locked"); },
            "x",
            wait: pause => { now += pause; return Task.CompletedTask; },
            elapsed: () => now);
        Assert.False(ok);
        Assert.InRange(now, TimeSpan.FromMilliseconds(900), TimeSpan.FromSeconds(1));
        Assert.True(calls < ClipboardRetry.DefaultAttempts + 1);
    }

    [Fact]
    public void Sync_BlockingIsCappedAtTheBudget_AndNeverThrows()
    {
        var now = TimeSpan.Zero;
        var slept = TimeSpan.Zero;
        var ok = ClipboardRetry.TryRun(
            () => throw new InvalidOperationException("locked"),
            attempts: 1000,
            sleep: pause => { slept += pause; now += pause; },
            elapsed: () => now);
        Assert.False(ok);
        Assert.True(slept <= TimeSpan.FromSeconds(1), $"slept {slept}");
    }

    [Fact]
    public void Sync_SucceedsAfterABusyMoment()
    {
        var calls = 0;
        var ok = ClipboardRetry.TryRun(() => { calls++; if (calls < 3) throw new InvalidOperationException("busy"); }, sleep: _ => { });
        Assert.True(ok);
        Assert.Equal(3, calls);
    }

    [Fact]
    public void Sync_TrySet_PassesTheTextThrough()
    {
        string? seen = null;
        Assert.True(ClipboardRetry.TrySet(t => seen = t, "code-b", sleep: _ => { }));
        Assert.Equal("code-b", seen);
    }
}
