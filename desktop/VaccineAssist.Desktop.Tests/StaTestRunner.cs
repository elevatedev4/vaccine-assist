using System;
using System.Runtime.ExceptionServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Threading;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Test-support helper for anything that touches RelayCommand/
/// AsyncRelayCommand's CanExecuteChanged wiring (see RelayCommand.cs's
/// doc comment) or otherwise depends on System.Windows.Input.CommandManager.
///
/// WHY THIS EXISTS (CI failure, 2026-09-14): CommandManager.
/// InvalidateRequerySuggested()/RaiseCanExecuteChanged() doesn't invoke
/// subscribed CanExecuteChanged handlers inline — it marshals the
/// notification onto each subscriber's Dispatcher via a
/// Background-priority BeginInvoke. That requires the subscribing thread
/// to both have a Dispatcher and have something pump it. xunit's default
/// runner executes test methods on plain MTA thread-pool threads with no
/// Dispatcher and nothing pumping one, so the queued notification is
/// simply never delivered — RelayCommandRequeryTests' three tests and
/// PhysiciansViewModelVaccineGroupSupportTests'
/// UnsupportedFlagBlocksAddRuleEvenIfAStaleGroupOptionIsSomehowSelected
/// all failed on GitHub Actions' windows-latest runner for exactly this
/// reason (they evidently passed on whatever host Will ran them on
/// locally, which must have provided a pumped STA/Dispatcher context).
///
/// FIX: give the test body its own STA thread with a real Dispatcher,
/// then either explicitly pump it after triggering a requery
/// (PumpBackgroundPriority, for synchronous tests) or keep it pumping for
/// the body's whole lifetime (RunStaAsync, for async tests whose awaits
/// need to resume on that same pumped thread rather than hopping to the
/// ThreadPool).
/// </summary>
internal static class StaTestRunner
{
    /// <summary>
    /// Runs a fully synchronous test body on a new STA thread that owns a
    /// Dispatcher. The Dispatcher is not actively pumped (Dispatcher.Run
    /// is never called) — call PumpBackgroundPriority from inside
    /// <paramref name="action"/> after triggering a requery notification
    /// to flush it before asserting.
    /// </summary>
    public static void RunSta(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                // Creates (and binds to this thread) the Dispatcher that
                // CommandManager.RequerySuggested subscribers need in
                // order to be notified at all.
                _ = Dispatcher.CurrentDispatcher;
                action();
            }
            catch (Exception ex)
            {
                failure = ex;
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();

        if (failure is not null)
        {
            // Preserve the original exception type/stack (e.g. xunit's
            // own Assert failure) rather than wrapping it.
            ExceptionDispatchInfo.Capture(failure).Throw();
        }
    }

    /// <summary>
    /// Flushes the calling thread's Dispatcher queue up through
    /// Background priority — the priority CommandManager posts its
    /// requery notification at — so a just-triggered
    /// InvalidateRequerySuggested()/RaiseCanExecuteChanged() actually
    /// reaches subscribers before the caller asserts on the result.
    /// Dispatcher.Invoke pushes its own nested frame and drains
    /// everything already queued at or above the given priority before
    /// returning, even though Dispatcher.Run() was never called. Must be
    /// called on the same thread the Dispatcher (and the CanExecuteChanged
    /// subscription) was created on — i.e. from inside a RunSta action.
    /// </summary>
    public static void PumpBackgroundPriority()
    {
        Dispatcher.CurrentDispatcher.Invoke(() => { }, DispatcherPriority.Background);
    }

    /// <summary>
    /// Runs an async test body on a new STA thread whose Dispatcher is
    /// actively pumping (Dispatcher.Run) for the body's entire lifetime,
    /// with a DispatcherSynchronizationContext installed so every `await`
    /// inside resumes back on that same thread/queue instead of hopping to
    /// the ThreadPool. Needed for a test that awaits something (e.g.
    /// Task.Delay) after triggering a CanExecuteChanged requery — without
    /// an actively pumped Dispatcher backing that await, the queued
    /// notification is dropped the same way it is under xunit's plain MTA
    /// threads. Blocks the calling thread until the body completes.
    /// </summary>
    public static void RunStaAsync(Func<Task> asyncAction)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            var dispatcher = Dispatcher.CurrentDispatcher;
            SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(dispatcher));

            var bodyTask = asyncAction();
            bodyTask.ContinueWith(
                _ => dispatcher.BeginInvokeShutdown(DispatcherPriority.Background),
                TaskScheduler.Default);

            Dispatcher.Run();

            if (bodyTask.IsFaulted)
            {
                failure = bodyTask.Exception!.InnerException ?? bodyTask.Exception;
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();

        if (failure is not null)
        {
            ExceptionDispatchInfo.Capture(failure).Throw();
        }
    }
}
