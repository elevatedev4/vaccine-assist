using System;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Common;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Regression tests for the crash Will hit 2026-08-19/20 ("Clicking lots
/// make it crash" / "App crashes when I try to look at several tabs").
/// Root cause: AsyncRelayCommand.Execute is necessarily `async void`
/// (ICommand.Execute returns void), and had no catch around `await
/// _execute()` — an exception from ANY command whose own handler didn't
/// already wrap its body in try/catch (LoginViewModel.SignInAsync's
/// missing catch around the settings-file save was exactly this) had
/// nothing to catch it, so it propagated straight out of an async void
/// method. These tests exercise Execute directly, without needing a live
/// WPF Dispatcher/SynchronizationContext, since the failure mode here is
/// "does the exception get caught before Execute returns," which doesn't
/// require one.
/// </summary>
public class AsyncRelayCommandExceptionTests
{
    [Fact]
    public void ExecuteDoesNotThrowWhenTheWrappedDelegateThrowsSynchronously()
    {
        var command = new AsyncRelayCommand(() => throw new InvalidOperationException("boom"));

        var exception = Record.Exception(() => command.Execute(null));

        Assert.Null(exception);
    }

    [Fact]
    public async Task ExecuteResetsIsExecutingAfterTheWrappedDelegateThrows()
    {
        // The finally clause must still run so a faulted command doesn't
        // leave its button permanently disabled — the same guarantee a
        // successful run already had.
        var command = new AsyncRelayCommand(() => throw new InvalidOperationException("boom"));

        command.Execute(null);
        // Execute is async void; give its (synchronously-throwing) path a
        // turn to finish running before asserting.
        await Task.Delay(10);

        Assert.True(command.CanExecute(null));
    }

    [Fact]
    public async Task ExecuteDoesNotThrowWhenTheAwaitedTaskFaults()
    {
        var command = new AsyncRelayCommand(async () =>
        {
            await Task.Delay(1);
            throw new InvalidOperationException("boom after await");
        });

        command.Execute(null);
        await Task.Delay(50);

        Assert.True(command.CanExecute(null));
    }
}
