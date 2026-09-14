using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Services;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Unit tests for StartupSignInCoordinator — the timeout/decision logic
/// extracted out of App.xaml.cs's StartSignInFlowAsync for the splash-hang
/// bug fix (Will, 2026-09-14: "shows the splash floating mid-screen and
/// never moves on; there is no way to close it"). No WPF/Dispatcher
/// involved here — this class only deals in plain delegates/Tasks, so
/// these run on xunit's default thread pool like the rest of this
/// project's non-UI tests (StaTestRunner is only needed for anything that
/// touches CommandManager/a real Dispatcher, which this doesn't).
/// Short TimeSpans (tens of milliseconds) keep the timeout/cancel tests
/// fast without being flaky under CI's windows-latest load.
/// </summary>
public class StartupSignInCoordinatorTests
{
    [Fact]
    public async Task SuccessReturnsSignedIn()
    {
        var coordinator = new StartupSignInCoordinator(attempt: _ => Task.FromResult(true));

        var result = await coordinator.RunAsync();

        Assert.Equal(StartupSignInOutcome.SignedIn, result.Outcome);
        Assert.Null(result.LoginMessage);
    }

    [Fact]
    public async Task FailureReturnsShowLoginWithNoMessage()
    {
        // The attempt completed (no exception, no timeout) but simply
        // didn't sign in — e.g. TrySilentSignInAsync ran fine but there
        // was genuinely nothing to restore. Not treated as an error.
        var coordinator = new StartupSignInCoordinator(attempt: _ => Task.FromResult(false));

        var result = await coordinator.RunAsync();

        Assert.Equal(StartupSignInOutcome.ShowLogin, result.Outcome);
        Assert.Null(result.LoginMessage);
    }

    [Fact]
    public async Task ExceptionInsideTheAttemptReturnsShowLoginWithTheReason()
    {
        var coordinator = new StartupSignInCoordinator(
            attempt: _ => Task.FromException<bool>(new InvalidOperationException("network unreachable")));

        var result = await coordinator.RunAsync();

        Assert.Equal(StartupSignInOutcome.ShowLogin, result.Outcome);
        Assert.Contains("network unreachable", result.LoginMessage);
    }

    [Fact]
    public async Task ExceptionThrownSynchronouslyBuildingTheAttemptReturnsShowLoginWithTheReason()
    {
        // Covers a delegate that throws before ever handing back a Task
        // (e.g. a synchronous argument-validation failure) — distinct code
        // path from an already-faulted Task above.
        var coordinator = new StartupSignInCoordinator(
            attempt: _ => throw new InvalidOperationException("boom"));

        var result = await coordinator.RunAsync();

        Assert.Equal(StartupSignInOutcome.ShowLogin, result.Outcome);
        Assert.Contains("boom", result.LoginMessage);
    }

    [Fact]
    public async Task TimesOutAfterTheLimitAndReturnsATimeoutMessage()
    {
        var attemptCompletion = new TaskCompletionSource<bool>();
        var coordinator = new StartupSignInCoordinator(
            attempt: _ => attemptCompletion.Task, // never completes on its own
            timeLimit: TimeSpan.FromMilliseconds(30));

        var result = await coordinator.RunAsync();

        Assert.Equal(StartupSignInOutcome.ShowLogin, result.Outcome);
        Assert.Equal("Automatic sign-in timed out — sign in manually", result.LoginMessage);
    }

    [Fact]
    public async Task ALateSuccessfulCompletionAfterATimeoutIsIgnored()
    {
        // The whole point of the 15s cap: the app must move on before the
        // hung attempt ever finishes, and that finish (whichever way it
        // goes) must never surface again once the decision is made.
        var attemptCompletion = new TaskCompletionSource<bool>();
        var coordinator = new StartupSignInCoordinator(
            attempt: _ => attemptCompletion.Task,
            timeLimit: TimeSpan.FromMilliseconds(30));

        var result = await coordinator.RunAsync();
        Assert.Equal(StartupSignInOutcome.ShowLogin, result.Outcome);
        Assert.Equal("Automatic sign-in timed out — sign in manually", result.LoginMessage);

        // The abandoned attempt now "succeeds" well after the decision was
        // already returned — must not throw/crash and must not change the
        // already-returned result.
        attemptCompletion.SetResult(true);
        await Task.Delay(50);

        Assert.Equal(StartupSignInOutcome.ShowLogin, result.Outcome);
        Assert.Equal("Automatic sign-in timed out — sign in manually", result.LoginMessage);
    }

    [Fact]
    public async Task ALateFaultedCompletionAfterATimeoutIsObservedAndSwallowed()
    {
        // Same as above but the abandoned attempt faults instead of
        // succeeding — must not become an UnobservedTaskException.
        var attemptCompletion = new TaskCompletionSource<bool>();
        var coordinator = new StartupSignInCoordinator(
            attempt: _ => attemptCompletion.Task,
            timeLimit: TimeSpan.FromMilliseconds(30));

        var result = await coordinator.RunAsync();
        Assert.Equal(StartupSignInOutcome.ShowLogin, result.Outcome);

        var exception = Record.Exception(() => attemptCompletion.SetException(new InvalidOperationException("late boom")));
        Assert.Null(exception);

        await Task.Delay(50); // let ObserveLateCompletion's continuation run
    }

    [Fact]
    public async Task CancelReturnsShowLoginWithACancelMessage()
    {
        var attemptCompletion = new TaskCompletionSource<bool>();
        using var cancelSource = new CancellationTokenSource();
        var coordinator = new StartupSignInCoordinator(
            attempt: _ => attemptCompletion.Task,
            timeLimit: TimeSpan.FromSeconds(5)); // long enough that only Cancel can end this test

        var runTask = coordinator.RunAsync(cancelSource.Token);
        cancelSource.Cancel();
        var result = await runTask;

        Assert.Equal(StartupSignInOutcome.ShowLogin, result.Outcome);
        Assert.Equal("Sign-in cancelled — sign in manually", result.LoginMessage);
    }

    [Fact]
    public async Task ALateCompletionAfterACancelIsIgnored()
    {
        var attemptCompletion = new TaskCompletionSource<bool>();
        using var cancelSource = new CancellationTokenSource();
        var coordinator = new StartupSignInCoordinator(
            attempt: _ => attemptCompletion.Task,
            timeLimit: TimeSpan.FromSeconds(5));

        var runTask = coordinator.RunAsync(cancelSource.Token);
        cancelSource.Cancel();
        var result = await runTask;
        Assert.Equal(StartupSignInOutcome.ShowLogin, result.Outcome);

        attemptCompletion.SetResult(true);
        await Task.Delay(50);

        Assert.Equal(StartupSignInOutcome.ShowLogin, result.Outcome);
        Assert.Equal("Sign-in cancelled — sign in manually", result.LoginMessage);
    }

    [Fact]
    public async Task LogsTheReasonWhenTheAttemptThrows()
    {
        var logs = new List<string>();
        var coordinator = new StartupSignInCoordinator(
            attempt: _ => Task.FromException<bool>(new InvalidOperationException("boom")),
            log: logs.Add);

        await coordinator.RunAsync();

        Assert.Contains(logs, line => line.Contains("boom"));
    }

    [Fact]
    public async Task LogsOnTimeout()
    {
        var logs = new List<string>();
        var coordinator = new StartupSignInCoordinator(
            attempt: _ => new TaskCompletionSource<bool>().Task,
            timeLimit: TimeSpan.FromMilliseconds(30),
            log: logs.Add);

        await coordinator.RunAsync();

        Assert.Contains(logs, line => line.Contains("timed out"));
    }

    [Fact]
    public void DefaultTimeLimitIsFifteenSeconds()
    {
        Assert.Equal(TimeSpan.FromSeconds(15), StartupSignInCoordinator.DefaultTimeLimit);
    }
}
