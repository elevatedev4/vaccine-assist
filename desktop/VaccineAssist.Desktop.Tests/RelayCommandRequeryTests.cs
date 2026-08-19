using System;
using System.Windows.Input;
using VaccineAssist.Desktop.Common;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Regression tests for the "can't click any submit buttons" bug (Will,
/// 2026-08-19, data-entry popup) — root cause was RelayCommand/
/// AsyncRelayCommand's CanExecuteChanged being a private event field that
/// nothing ever raised when the ViewModel state a button's CanExecute
/// depended on changed, so WPF queried CanExecute once at binding time
/// and never again. The fix hooks CanExecuteChanged to
/// CommandManager.RequerySuggested, the shared event WPF's input system
/// raises automatically. These tests exercise that wiring directly,
/// without a live Window/Dispatcher loop.
///
/// NOTE: unlike this project's other tests, these touch a WPF type
/// (System.Windows.Input.CommandManager) transitively via the
/// VaccineAssist.Desktop project reference — see that project's UseWPF
/// setting. Could not be run on macOS in this session (see report); if
/// they fail to even load on a Windows CI/test host, that's worth
/// flagging back rather than assumed-passing.
/// </summary>
public class RelayCommandRequeryTests
{
    [Fact]
    public void RelayCommandCanExecuteChangedFiresOnCommandManagerRequerySuggested()
    {
        var command = new RelayCommand(() => { });
        var raised = false;
        EventHandler handler = (_, _) => raised = true;

        command.CanExecuteChanged += handler;
        try
        {
            CommandManager.InvalidateRequerySuggested();
            Assert.True(raised);
        }
        finally
        {
            command.CanExecuteChanged -= handler;
        }
    }

    [Fact]
    public void AsyncRelayCommandCanExecuteChangedFiresOnCommandManagerRequerySuggested()
    {
        var command = new AsyncRelayCommand(() => System.Threading.Tasks.Task.CompletedTask);
        var raised = false;
        EventHandler handler = (_, _) => raised = true;

        command.CanExecuteChanged += handler;
        try
        {
            CommandManager.InvalidateRequerySuggested();
            Assert.True(raised);
        }
        finally
        {
            command.CanExecuteChanged -= handler;
        }
    }

    [Fact]
    public void RaiseCanExecuteChangedAlsoTriggersASubscribedHandlerImmediately()
    {
        // RaiseCanExecuteChanged() now calls CommandManager.InvalidateRequerySuggested()
        // instead of invoking a private event field directly (see RelayCommand.cs) —
        // confirms that path still works for callers that want an immediate re-query
        // (e.g. right after IsBusy flips) rather than waiting on the next UI event.
        var command = new RelayCommand(() => { });
        var raised = false;
        EventHandler handler = (_, _) => raised = true;

        command.CanExecuteChanged += handler;
        try
        {
            command.RaiseCanExecuteChanged();
            Assert.True(raised);
        }
        finally
        {
            command.CanExecuteChanged -= handler;
        }
    }
}
