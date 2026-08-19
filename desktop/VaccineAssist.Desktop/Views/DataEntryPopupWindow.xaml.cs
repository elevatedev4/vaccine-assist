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
}
