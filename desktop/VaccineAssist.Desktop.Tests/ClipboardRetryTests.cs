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
}
