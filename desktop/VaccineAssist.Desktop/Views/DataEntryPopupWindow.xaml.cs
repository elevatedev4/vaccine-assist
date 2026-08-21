using System.Windows;
using System.Windows.Controls;
using VaccineAssist.Desktop.Models;
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
    /// V-T3 item 4 (Will, 2026-08-19/20): the vaccine picker is a
    /// RadioButton list (see DataEntryPopupWindow.xaml), not a ComboBox.
    /// WPF has no built-in "SelectedItem" concept for a
    /// group of individually-templated RadioButtons — a MultiBinding
    /// converter can't reach a row's own item either (ConverterParameter
    /// isn't bindable), so this handles it the same plain code-behind way
    /// the rest of this app wires things (see App.xaml.cs's composition-
    /// root doc comment on the DI-light style): every RadioButton the
    /// ItemsControl's DataTemplate instantiates has its own Checked="..."
    /// handler (see DataEntryPopupWindow.xaml) pointed at this one method;
    /// `sender` is whichever RadioButton the user just checked, and its
    /// DataContext (set by the DataTemplate) is that row's Vaccine.
    /// </summary>
    private void VaccineRadioList_OnChecked(object sender, RoutedEventArgs e)
    {
        if (sender is RadioButton { DataContext: Vaccine vaccine })
        {
            _viewModel.SelectedVaccine = vaccine;
        }
    }
}
