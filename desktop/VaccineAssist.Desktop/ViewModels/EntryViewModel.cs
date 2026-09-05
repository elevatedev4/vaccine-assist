using System;
using System.Threading.Tasks;
using System.Windows.Input;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Services;
using VaccineAssist.Desktop.Uia;

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
///
/// Also the "debug corner" home for V-... Part A's UIA tree-dump collector
/// (Uia/UiaTreeDumper.cs) — this tab is the natural place for it: it's
/// already a lightweight status/debug surface, reachable without opening
/// the data-entry popup at all (the popup has its own copy of the same
/// button too, for when a dump is needed mid-entry).
/// </summary>
public sealed class EntryViewModel : ObservableObject
{
    private readonly Action _openDataEntryPopup;
    private readonly IClipboardService _clipboardService;
    private bool _isHotkeyActive;
    private bool _isBusy;
    private string? _statusMessage;
    private string? _errorMessage;

    public EntryViewModel(Action openDataEntryPopup, IClipboardService clipboardService)
    {
        _openDataEntryPopup = openDataEntryPopup ?? throw new ArgumentNullException(nameof(openDataEntryPopup));
        _clipboardService = clipboardService ?? throw new ArgumentNullException(nameof(clipboardService));
        OpenPopupCommand = new RelayCommand(() => _openDataEntryPopup());
        DumpUiaTreeCommand = new AsyncRelayCommand(DumpUiaTreeAsync, () => !IsBusy);
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

    public bool IsBusy
    {
        get => _isBusy;
        private set => SetProperty(ref _isBusy, value);
    }

    public string? StatusMessage
    {
        get => _statusMessage;
        private set => SetProperty(ref _statusMessage, value);
    }

    public string? ErrorMessage
    {
        get => _errorMessage;
        private set => SetProperty(ref _errorMessage, value);
    }

    /// <summary>Manual trigger — opens the same popup the hotkey does.</summary>
    public ICommand OpenPopupCommand { get; }

    /// <summary>V-... Part A: dumps the attached PioneerRx window's full UIA
    /// tree to %AppData%\VaccineAssist\uia-dumps\ — see Uia/UiaTreeDumper.cs.
    /// Same command shape as DataEntryPopupViewModel.DumpUiaTreeCommand
    /// (deliberately not shared/refactored into one place given how small
    /// each copy is — the two ViewModels have no other relationship).</summary>
    public ICommand DumpUiaTreeCommand { get; }

    private async Task DumpUiaTreeAsync()
    {
        IsBusy = true;
        ErrorMessage = null;
        try
        {
            var outcome = await Task.Run(UiaTreeDumper.DumpAttachedPioneerWindow);
            if (outcome.Success && outcome.Content is not null)
            {
                // Will, 2026-09-05: "copy the log it generates to the
                // clipboard so I don't have to go find it in the file" —
                // copies the DUMP TEXT itself, not just the saved path
                // (the file is still written too, see UiaTreeDumper).
                _clipboardService.SetText(outcome.Content);
                StatusMessage = outcome.Message;
            }
            else
            {
                ErrorMessage = outcome.Message;
            }
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't dump the UIA tree: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }
}
