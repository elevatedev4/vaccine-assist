using System.Windows.Input;

namespace VaccineAssist.Desktop.Common;

/// <summary>
/// Synchronous, parameterized sibling of RelayCommand — for per-row
/// actions bound via CommandParameter="{Binding}" that don't need
/// AsyncRelayCommand&lt;T&gt;'s re-entrancy guard because they do no I/O
/// (e.g. removing a row from an in-memory ObservableCollection before
/// Save — see Fax/FaxSettingsViewModel.cs's prescriber/column-map grids).
/// Same CommandManager.RequerySuggested wiring as RelayCommand/
/// AsyncRelayCommand&lt;T&gt; — see RelayCommand's own doc comment for the
/// full root-cause writeup this mirrors.
/// </summary>
public sealed class RelayCommandOfT<T> : ICommand
{
    private readonly Action<T?> _execute;
    private readonly Func<T?, bool>? _canExecute;

    public RelayCommandOfT(Action<T?> execute, Func<T?, bool>? canExecute = null)
    {
        _execute = execute ?? throw new ArgumentNullException(nameof(execute));
        _canExecute = canExecute;
    }

    public event EventHandler? CanExecuteChanged
    {
        add => CommandManager.RequerySuggested += value;
        remove => CommandManager.RequerySuggested -= value;
    }

    public bool CanExecute(object? parameter) => _canExecute?.Invoke(CastParameter(parameter)) ?? true;

    public void Execute(object? parameter) => _execute(CastParameter(parameter));

    public void RaiseCanExecuteChanged() => CommandManager.InvalidateRequerySuggested();

    private static T? CastParameter(object? parameter) => parameter is T typed ? typed : default;
}
