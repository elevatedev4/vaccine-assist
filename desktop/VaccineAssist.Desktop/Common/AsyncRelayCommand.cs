using System;
using System.Threading.Tasks;
using System.Windows.Input;

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
