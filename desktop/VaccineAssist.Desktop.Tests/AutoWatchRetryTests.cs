using System;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-T28: AutoWatchRetry.RunAsync retries a recoverable (timeout-shaped —
/// see AutoWatchErrorClassifier) failure against a WALL-CLOCK budget driven
/// by an injected fake clock, so these run instantly with no real waiting —
/// same "pure polling primitive, real waits injected by the live caller"
/// pattern as SendF3AndDismissPreEntryDialogsStepTests.cs's coverage of
/// DismissPendingDialogsAsync/DismissAllStrayWindowsAsync/WaitForAsync.
/// </summary>
public class AutoWatchRetryTests
{
    /// <summary>Fake clock that advances by a fixed step every time `now`
    /// is called from inside AutoWatchRetry's `onRecoverableWait` callback —
    /// lets a test simulate "N seconds have passed" without a real
    /// Task.Delay.</summary>
    private sealed class FakeClock
    {
        private DateTime _current = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        public TimeSpan Step { get; init; } = TimeSpan.FromSeconds(1);
        public DateTime Now() => _current;
        public void Advance() => _current += Step;
    }

    [Fact]
    public async Task SucceedsImmediatelyWithoutRetryingWhenTheFirstAttemptWorks()
    {
        var clock = new FakeClock();
        var waited = 0;

        var result = await AutoWatchRetry.RunAsync(
            attempt: () => 42,
            overallBudget: TimeSpan.FromSeconds(60),
            now: clock.Now,
            onRecoverableWait: (_, _) => { waited++; return Task.CompletedTask; });

        Assert.Equal(42, result);
        Assert.Equal(0, waited);
    }

    [Fact]
    public async Task RetriesARecoverableFailureAndEventuallySucceedsWithinBudget()
    {
        var clock = new FakeClock();
        var attempts = 0;
        var waits = 0;

        var result = await AutoWatchRetry.RunAsync(
            attempt: () =>
            {
                attempts++;
                if (attempts < 3) throw new TimeoutException("Operation timed out.");
                return "ok";
            },
            overallBudget: TimeSpan.FromSeconds(60),
            now: clock.Now,
            onRecoverableWait: (ex, elapsed) =>
            {
                waits++;
                Assert.IsType<TimeoutException>(ex);
                clock.Advance();
                return Task.CompletedTask;
            });

        Assert.Equal("ok", result);
        Assert.Equal(3, attempts);
        Assert.Equal(2, waits);
    }

    [Fact]
    public async Task RethrowsTheSameRecoverableExceptionOnceTheOverallBudgetIsExhausted()
    {
        // Fake clock advances 10s per recoverable wait — with a 25s budget
        // this gives up after the 3rd failed attempt (elapsed 20s -> wait
        // -> 3rd attempt fails at 20s already-elapsed, next wait would push
        // to 30s >= 25s budget, so it rethrows instead of waiting again).
        var clock = new FakeClock { Step = TimeSpan.FromSeconds(10) };
        var waits = 0;

        var thrown = await Assert.ThrowsAsync<TimeoutException>(() => AutoWatchRetry.RunAsync<int>(
            attempt: () => throw new TimeoutException("Operation timed out."),
            overallBudget: TimeSpan.FromSeconds(25),
            now: clock.Now,
            onRecoverableWait: (_, _) =>
            {
                waits++;
                clock.Advance();
                return Task.CompletedTask;
            }));

        Assert.Equal("Operation timed out.", thrown.Message);
        // Budget/step means: attempt (0s) -> wait #1 (advance to 10s) ->
        // attempt (10s) -> wait #2 (advance to 20s) -> attempt (20s, still
        // under 25s) -> wait #3 (advance to 30s) -> attempt (30s >= 25s ->
        // rethrow without waiting again).
        Assert.Equal(3, waits);
    }

    [Fact]
    public async Task NonRecoverableExceptionPropagatesImmediatelyWithoutAnyRetry()
    {
        var clock = new FakeClock();
        var attempts = 0;
        var waited = false;

        await Assert.ThrowsAsync<InvalidOperationException>(() => AutoWatchRetry.RunAsync<int>(
            attempt: () =>
            {
                attempts++;
                throw new InvalidOperationException("Couldn't find the lot number field.");
            },
            overallBudget: TimeSpan.FromSeconds(60),
            now: clock.Now,
            onRecoverableWait: (_, _) => { waited = true; return Task.CompletedTask; }));

        Assert.Equal(1, attempts);
        Assert.False(waited);
    }

    [Fact]
    public async Task HonorsCancellationBetweenAttempts()
    {
        var clock = new FakeClock();
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(() => AutoWatchRetry.RunAsync<int>(
            attempt: () => 1,
            overallBudget: TimeSpan.FromSeconds(60),
            now: clock.Now,
            onRecoverableWait: (_, _) => Task.CompletedTask,
            cancellationToken: cts.Token));
    }
}
