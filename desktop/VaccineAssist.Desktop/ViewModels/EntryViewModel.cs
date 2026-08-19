using System;
using System.Windows.Input;
using VaccineAssist.Desktop.Common;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>
/// Backs the "Data entry" tab — repurposed 2026-08-19 per Will's feedback:
/// this used to be a full second data-entry form (vaccine/lot/admin
/// site/age/pregnant fields, eligibility check, clipboard payload),
/// duplicating the Ctrl+NumPad2 popup (DataEntryPopupViewModel) almost
/// field-for-field. Will's words: data entry should happen through
/// exactly one place — the popup — so this tab is now just a lightweight
/// status/settings surface for the hotkey feature, not a second entry
/// form. See MainWindow, which is the only thing that actually knows
/// whether the hotkey registered and how to show the popup.
/// </summary>
public sealed class EntryViewModel : ObservableObject
{
    private readonly Action _openDataEntryPopup;
    private bool _isHotkeyActive;

    public EntryViewModel(Action openDataEntryPopup)
    {
        _openDataEntryPopup = openDataEntryPopup ?? throw new ArgumentNullException(nameof(openDataEntryPopup));
        OpenPopupCommand = new RelayCommand(() => _openDataEntryPopup());
    }

    /// <summary>Set by MainWindow right after GlobalHotKey.Register() runs
    /// (SourceInitialized) — true means Ctrl+NumPad2 is live anywhere in
    /// Windows; false means registration failed (e.g. another app already
    /// owns that combo), in which case OpenPopupCommand's button is the
    /// only way to reach the popup.</summary>
    public bool IsHotkeyActive
    {
        get => _isHotkeyActive;
        set => SetProperty(ref _isHotkeyActive, value);
    }

    /// <summary>Manual trigger — opens the same popup the hotkey does.</summary>
    public ICommand OpenPopupCommand { get; }
}
