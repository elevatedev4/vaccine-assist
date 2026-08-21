using System;
using System.Threading.Tasks;
using System.Windows.Input;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Common;

/// <summary>
/// ICommand for an async handler that guards against re-entrancy (a
/// second click while the first invocation's Task is still running is a
/// no-op) — every screen's "load"/"save"/"sign in" button uses this
/// rather than fire-and-forget async void handlers.
///
/// CanExecuteChanged is wired to CommandManager.RequerySuggested — see
/// RelayCommand.cs's doc comment for the full root-cause writeup of the
/// "can't click any submit buttons" bug this fixes. Without this, a
/// button whose CanExecute depends on ViewModel state (SelectedVaccine,
/// PatientAgeYears, etc.) only got queried once, at binding time, and
/// then never again — it looked and behaved permanently disabled no
/// matter what the user typed/selected afterward.
///
/// CRASH FIX (Will, 2026-08-19/20: "clicking lots make it crash" /
/// "crashes when I try to look at several tabs"): Execute is necessarily
/// `async void` (ICommand.Execute returns void, so there's no Task for a
/// caller to await/observe) — before this fix, an exception thrown by
/// `_execute()` itself, or by the awaited Task faulting, had no catch
/// here at all and propagated straight out of an async void method. Most
/// ViewModels' Load/Save methods already wrap their own bodies in
/// try/catch and surface an inline ErrorMessage (the right per-tab UX),
/// but that only helps if EVERY current and future command handler
/// remembers to do it — one that doesn't (LoginViewModel.SignInAsync's
/// missing catch around the settings-file save was exactly this) turned
/// a recoverable failure into a hard app-wide crash. This catch is the
/// backstop: it can't produce the same nice inline per-field message a
/// ViewModel's own try/catch can (this class has no ErrorMessage
/// property to set), but it guarantees a faulted command can never take
/// the whole app down, and the finally clause still resets IsExecuting
/// so the button isn't left permanently disabled afterward. Logged (never
/// shown to the user directly) via AppFileLog so a crash-shaped bug still
/// leaves a trace; App.xaml.cs's DispatcherUnhandledException handler is
/// the second, independent backstop for anything that still slips past
/// this (e.g. a synchronous RelayCommand.Execute, which has no Task to
/// catch around at all).
/// </summary>
public sealed class AsyncRelayCommand : ICommand
{
    private readonly Func<Task> _execute;
    private readonly Func<bool>? _canExecute;
    private bool _isExecuting;

    public AsyncRelayCommand(Func<Task> execute, Func<bool>? canExecute = null)
    {
        _execute = execute ?? throw new ArgumentNullException(nameof(execute));
        _canExecute = canExecute;
    }

    public event EventHandler? CanExecuteChanged
    {
        add => CommandManager.RequerySuggested += value;
        remove => CommandManager.RequerySuggested -= value;
    }

    public bool CanExecute(object? parameter) => !_isExecuting && (_canExecute?.Invoke() ?? true);

    public async void Execute(object? parameter)
    {
        if (!CanExecute(parameter)) return;

        _isExecuting = true;
        RaiseCanExecuteChanged();
        try
        {
            await _execute();
        }
        catch (Exception ex)
        {
            // See class doc comment — this is a backstop, not a
            // substitute for the ViewModel's own inline ErrorMessage
            // handling. Swallowed deliberately: an unhandled exception
            // here (async void, no Task for anyone to observe) would
            // otherwise crash the whole app.
            AppFileLog.LogException("AsyncRelayCommand", ex);
        }
        finally
        {
            _isExecuting = false;
            RaiseCanExecuteChanged();
        }
    }

    /// <summary>Forces an immediate re-query right away (e.g. right after
    /// _isExecuting flips) instead of waiting for the next
    /// CommandManager-detected UI event.</summary>
    public void RaiseCanExecuteChanged() => CommandManager.InvalidateRequerySuggested();
}
