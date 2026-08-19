using System;
using System.Windows;
using VaccineAssist.Desktop.ViewModels;

namespace VaccineAssist.Desktop.Views;

/// <summary>
/// The Ctrl+NumPad2 popup (V-T3). Non-modal (Show, not ShowDialog) so the
/// pharmacist can still click back into PioneerRx while this stays
/// Topmost — matches the "quick popup while working the Rx profile"
/// workflow described in the brief. A fresh DataEntryPopupViewModel is
/// created per popup instance (see MainWindow.xaml.cs) and discarded on
/// Closed, so PatientAgeYears never outlives one popup session.
/// </summary>
public partial class DataEntryPopupWindow : Window
{
    private readonly DataEntryPopupViewModel _viewModel;

    public DataEntryPopupWindow(DataEntryPopupViewModel viewModel)
    {
        InitializeComponent();
        _viewModel = viewModel;
        DataContext = _viewModel;
    }

    private async void DataEntryPopupWindow_OnLoaded(object sender, RoutedEventArgs e)
    {
        await _viewModel.LoadAsync();
    }

    /// <summary>
    /// Known WPF quirk: a ComboBox's drop-down Popup doesn't reliably
    /// inherit its parent window's Topmost placement on an owner-less/
    /// Topmost utility window like this one — it can render behind other
    /// topmost windows (e.g. PioneerRx itself), which is exactly what
    /// "hard to see" looks like. Toggling Topmost off/on forces WPF to
    /// reissue the underlying SetWindowPos(...HWND_TOPMOST...) call for
    /// this window right as the drop-down opens, pulling it (and its
    /// popup) back above everything else. UNVERIFIED without a live
    /// Windows/PioneerRx session — see report.
    /// </summary>
    private void VaccineComboBox_OnDropDownOpened(object? sender, EventArgs e)
    {
        Topmost = false;
        Topmost = true;
    }
}
