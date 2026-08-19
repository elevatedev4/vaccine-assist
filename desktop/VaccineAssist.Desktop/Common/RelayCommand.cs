using System;
using System.Windows.Input;

namespace VaccineAssist.Desktop.Common;

/// <summary>
/// Simple synchronous ICommand — no MVVM toolkit dependency.
///
/// CanExecuteChanged is wired to CommandManager.RequerySuggested rather
/// than a private event field. Root cause of "I can't click any submit
/// buttons" (Will, 2026-08-19, data-entry popup): every button here binds
/// Command with a CanExecute delegate that reads ViewModel state (e.g.
/// "SelectedVaccine is not null"), but nothing ever called
/// RaiseCanExecuteChanged() when that state changed after construction —
/// WPF queried CanExecute exactly once, at binding time (false, since no
/// vaccine/age had been picked yet), and never asked again. The button
/// rendered disabled and stayed disabled forever, even after the user
/// filled in the form — which reads to a user as "the button doesn't do
/// anything when I click it." CommandManager.RequerySuggested is the
/// standard WPF fix: WPF's input system already raises it on the UI
/// activity that follows normal form interaction (focus changes, clicks,
/// key presses), so hooking every command's CanExecuteChanged to it makes
/// CanExecute re-evaluate automatically without every ViewModel property
/// setter needing to know which commands depend on it.
/// </summary>
public sealed class RelayCommand : ICommand
{
    private readonly Action _execute;
    private readonly Func<bool>? _canExecute;

    public RelayCommand(Action execute, Func<bool>? canExecute = null)
    {
        _execute = execute ?? throw new ArgumentNullException(nameof(execute));
        _canExecute = canExecute;
    }

    public event EventHandler? CanExecuteChanged
    {
        add => CommandManager.RequerySuggested += value;
        remove => CommandManager.RequerySuggested -= value;
    }

    public bool CanExecute(object? parameter) => _canExecute?.Invoke() ?? true;

    public void Execute(object? parameter) => _execute();

    /// <summary>Still exposed for callers that want to force an immediate
    /// re-query right away (e.g. right after IsBusy flips) instead of
    /// waiting for the next CommandManager-detected UI event.</summary>
    public void RaiseCanExecuteChanged() => CommandManager.InvalidateRequerySuggested();
}
