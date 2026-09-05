using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
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

    /// <summary>
    /// GUIDED FLOW rework (V-... Part B): the popup no longer preloads a
    /// flat vaccine list (there's nothing to load until an age is entered
    /// — see DataEntryPopupViewModel.ContinueFromAgeAsync), so this now
    /// just autofocuses the age textbox — "keep it a fast textbox,
    /// autofocused" per the brief — instead of the old LoadAsync() call.
    /// </summary>
    private void DataEntryPopupWindow_OnLoaded(object sender, RoutedEventArgs e)
    {
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
