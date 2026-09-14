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
/// setting.
///
/// CI FIX (2026-09-14): CommandManager.InvalidateRequerySuggested()/
/// RaiseCanExecuteChanged() doesn't call subscribed handlers inline — it
/// marshals the notification onto each subscriber's Dispatcher via a
/// Background-priority BeginInvoke. That silently goes nowhere on
/// xunit's default MTA thread-pool threads (no Dispatcher, nothing
/// pumping one), which is exactly why these three passed on whatever
/// host Will ran them on locally but failed on GitHub Actions'
/// windows-latest runner. Each test now runs on a dedicated STA thread
/// with a real Dispatcher (StaTestRunner.RunSta) and explicitly flushes
/// that Dispatcher's Background-priority queue (PumpBackgroundPriority)
/// right after triggering the requery, before asserting the handler fired.
/// </summary>
public class RelayCommandRequeryTests
{
    [Fact]
    public void RelayCommandCanExecuteChangedFiresOnCommandManagerRequerySuggested()
    {
        StaTestRunner.RunSta(() =>
        {
            var command = new RelayCommand(() => { });
            var raised = false;
            EventHandler handler = (_, _) => raised = true;

            command.CanExecuteChanged += handler;
            try
            {
                CommandManager.InvalidateRequerySuggested();
                StaTestRunner.PumpBackgroundPriority();
                Assert.True(raised);
            }
            finally
            {
                command.CanExecuteChanged -= handler;
            }
        });
    }

    [Fact]
    public void AsyncRelayCommandCanExecuteChangedFiresOnCommandManagerRequerySuggested()
    {
        StaTestRunner.RunSta(() =>
        {
            var command = new AsyncRelayCommand(() => System.Threading.Tasks.Task.CompletedTask);
            var raised = false;
            EventHandler handler = (_, _) => raised = true;

            command.CanExecuteChanged += handler;
            try
            {
                CommandManager.InvalidateRequerySuggested();
                StaTestRunner.PumpBackgroundPriority();
                Assert.True(raised);
            }
            finally
            {
                command.CanExecuteChanged -= handler;
            }
        });
    }

    [Fact]
    public void RaiseCanExecuteChangedAlsoTriggersASubscribedHandlerImmediately()
    {
        // RaiseCanExecuteChanged() now calls CommandManager.InvalidateRequerySuggested()
        // instead of invoking a private event field directly (see RelayCommand.cs) —
        // confirms that path still works for callers that want an immediate re-query
        // (e.g. right after IsBusy flips) rather than waiting on the next UI event.
        // "Immediate" here means "the next time something pumps the Dispatcher this
        // thread posted the notification to" — not synchronous — hence the explicit
        // pump before asserting, same as the other two tests in this file.
        StaTestRunner.RunSta(() =>
        {
            var command = new RelayCommand(() => { });
            var raised = false;
            EventHandler handler = (_, _) => raised = true;

            command.CanExecuteChanged += handler;
            try
            {
                command.RaiseCanExecuteChanged();
                StaTestRunner.PumpBackgroundPriority();
                Assert.True(raised);
            }
            finally
            {
                command.CanExecuteChanged -= handler;
            }
        });
    }
}
