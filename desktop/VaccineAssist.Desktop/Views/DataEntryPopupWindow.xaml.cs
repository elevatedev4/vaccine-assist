using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.ViewModels;

namespace VaccineAssist.Desktop.Views;

/// <summary>
/// The Ctrl+NumPad7 popup (V-T3). Non-modal (Show, not ShowDialog) so the
/// pharmacist can still click back into PioneerRx while this stays
/// Topmost — matches the "quick popup while working the Rx profile"
/// workflow described in the brief. A fresh DataEntryPopupViewModel is
/// created per popup instance (see MainWindow.xaml.cs) and discarded on
/// Closed, so PatientAgeYears never outlives one popup session.
/// </summary>
public partial class DataEntryPopupWindow : Window
{
    /// <summary>MSG893 item 2: see ActivateAndFocusAge's doc comment for
    /// why this P/Invoke is needed on top of Activate()/Focus().</summary>
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    private readonly DataEntryPopupViewModel _viewModel;

    public DataEntryPopupWindow(DataEntryPopupViewModel viewModel)
    {
        InitializeComponent();
        _viewModel = viewModel;
        DataContext = _viewModel;
    }

    /// <summary>
    /// GUIDED FLOW rework (V-... Part B): the popup no longer preloads a
    /// flat vaccine list (there's nothing to load until an age is entered
    /// — see DataEntryPopupViewModel.ContinueFromAgeAsync), so this just
    /// activates/focuses the age textbox on first show — "keep it a fast
    /// textbox, autofocused" per the brief — instead of the old LoadAsync()
    /// call. See ActivateAndFocusAge for the actual focus/activation work
    /// (MSG893 item 2 made this robust against the popup opening while
    /// PioneerRx is the foreground window).
    /// </summary>
    private void DataEntryPopupWindow_OnLoaded(object sender, RoutedEventArgs e)
    {
        ActivateAndFocusAge();
    }

    /// <summary>
    /// MSG893 item 2 ("Popup must take and keep focus, cursor in the age
    /// box"): brings this popup to the foreground and puts keyboard focus
    /// in the age textbox. Called from Loaded on first show, AND by
    /// MainWindow.ShowDataEntryPopup when the hotkey (or the "Open data
    /// entry popup" button) is pressed again while this popup is ALREADY
    /// open — that re-activates/re-focuses the existing popup instead of
    /// opening a duplicate.
    ///
    /// Plain Show() + Topmost="True" + Activate()/Focus() is not reliable
    /// here: this popup is launched from a GLOBAL hotkey while PioneerRx
    /// is the foreground window, and Windows' foreground-lock timeout
    /// normally refuses to let a background process steal keyboard focus
    /// from whatever the user is actively using. The popup can end up
    /// visually on top (Topmost) but WITHOUT keyboard focus, so typed
    /// digits keep going to PioneerRx instead of AgeTextBox — the exact
    /// "doesn't get keyboard focus" symptom reported. The fix is the
    /// standard one: call Activate() first (WPF's own focus/activation
    /// request), then P/Invoke SetForegroundWindow directly on this
    /// window's handle. SetForegroundWindow is itself normally subject to
    /// that same foreground-lock restriction UNLESS the calling thread
    /// currently holds foreground-activation rights — which Win32 GRANTS
    /// to whichever thread is processing a registered hotkey's WM_HOTKEY
    /// message (see Hotkeys/GlobalHotKey.cs's WndProc/Pressed event).
    /// MainWindow's GlobalHotKey.Pressed handler calls ShowDataEntryPopup()
    /// -&gt; this method SYNCHRONOUSLY on that same dispatcher callback, so
    /// the call below runs while those rights are still held for a
    /// fresh popup — legitimate, not a workaround. When the popup is
    /// instead opened/re-focused via a mouse click
    /// (EntryViewModel.OpenPopupCommand), the click itself already carries
    /// normal foreground rights, so this call is harmless there too.
    /// </summary>
    public void ActivateAndFocusAge()
    {
        Activate();

        var handle = new WindowInteropHelper(this).Handle;
        if (handle != IntPtr.Zero)
        {
            // Best-effort: per the Win32 contract this returns false on
            // failure rather than throwing, and Activate()/Focus() below
            // still run either way — a foreground-lock refusal here just
            // means the popup relies on Activate() alone, same as before
            // this fix for whatever edge case SetForegroundWindow itself
            // can't clear.
            SetForegroundWindow(handle);
        }

        AgeTextBox.Focus();
        Keyboard.Focus(AgeTextBox);
    }

    /// <summary>Enter in the age textbox is the fast path to the next
    /// question — same "keep it a fast textbox" reasoning as autofocus
    /// above. No-ops via CanExecute if the age isn't valid/present yet.</summary>
    private void AgeTextBox_OnKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Enter) return;
        if (_viewModel.ContinueFromAgeCommand.CanExecute(null))
        {
            _viewModel.ContinueFromAgeCommand.Execute(null);
        }
    }

    /// <summary>
    /// V-... Part B: each of the guided flow's three RadioButton lists
    /// (group / product / dose) is a plain ItemsControl with its own
    /// per-row Checked="..." handler pointed at one of these three
    /// methods — same pattern the pre-guided-flow vaccine picker used
    /// (WPF has no built-in "SelectedItem" concept for a set of
    /// individually templated RadioButtons — a MultiBinding converter
    /// can't reach a row's own item either, ConverterParameter isn't
    /// bindable). `sender` is whichever RadioButton the user just checked;
    /// its DataContext (set by the DataTemplate) is that row's item.
    /// </summary>
    private void GroupRadioList_OnChecked(object sender, RoutedEventArgs e)
    {
        if (sender is RadioButton { DataContext: string group })
        {
            _viewModel.SelectGroup(group);
        }
    }

    private void ProductRadioList_OnChecked(object sender, RoutedEventArgs e)
    {
        if (sender is RadioButton { DataContext: VaccineProductOption product })
        {
            _viewModel.SelectProduct(product);
        }
    }

    private void DoseRadioList_OnChecked(object sender, RoutedEventArgs e)
    {
        if (sender is RadioButton { DataContext: Vaccine doseVaccine })
        {
            _viewModel.SelectDose(doseVaccine);
        }
    }
}
