using System;
using System.Threading.Tasks;
using System.Windows.Input;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Common;

/// <summary>
/// Parameterized sibling of AsyncRelayCommand — for per-row actions bound
/// via CommandParameter="{Binding}" (e.g. a DataGrid row's own "Delete"
/// button, see the Physicians settings tab: DeletePhysicianCommand/
/// DeleteRuleCommand). Same re-entrancy guard, CommandManager.RequerySuggested
/// wiring, and never-crash-the-app catch/log as AsyncRelayCommand — see
/// that class's doc comment for the full root-cause writeups this mirrors;
/// not duplicated here since the reasoning is identical, just with a
/// parameter threaded through.
/// </summary>
public sealed class AsyncRelayCommand<T> : ICommand
{
    private readonly Func<T?, Task> _execute;
    private readonly Func<T?, bool>? _canExecute;
    private bool _isExecuting;

    public AsyncRelayCommand(Func<T?, Task> execute, Func<T?, bool>? canExecute = null)
    {
        _execute = execute ?? throw new ArgumentNullException(nameof(execute));
        _canExecute = canExecute;
    }

    public event EventHandler? CanExecuteChanged
    {
        add => CommandManager.RequerySuggested += value;
        remove => CommandManager.RequerySuggested -= value;
    }

    public bool CanExecute(object? parameter) => !_isExecuting && (_canExecute?.Invoke(CastParameter(parameter)) ?? true);

    public async void Execute(object? parameter)
    {
        if (!CanExecute(parameter)) return;

        _isExecuting = true;
        RaiseCanExecuteChanged();
        try
        {
            await _execute(CastParameter(parameter));
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("AsyncRelayCommand<T>", ex);
        }
        finally
        {
            _isExecuting = false;
            RaiseCanExecuteChanged();
        }
    }

    public void RaiseCanExecuteChanged() => CommandManager.InvalidateRequerySuggested();

    private static T? CastParameter(object? parameter) => parameter is T typed ? typed : default;
}
