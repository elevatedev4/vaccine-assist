using System.Windows;
using System.Windows.Controls;
using VaccineAssist.Desktop.ViewModels;

namespace VaccineAssist.Desktop.Views;

public partial class LotsView : UserControl
{
    private readonly LotsViewModel _viewModel;

    public LotsView(LotsViewModel viewModel)
    {
        InitializeComponent();
        _viewModel = viewModel;
        DataContext = _viewModel;
    }

    private async void LotsView_OnLoaded(object sender, RoutedEventArgs e)
    {
        await _viewModel.LoadAsync();
    }

    /// <summary>
    /// REVIEWER FIX (Minor): guards the Expiration column's DatePicker
    /// (LotsView.xaml) against being cleared. Expiration is a required,
    /// non-nullable DateTime on LotRowViewModel (unlike Beyond-use date,
    /// which has no such guard because it's meant to be clearable) — WPF's
    /// default TwoWay binding conversion can't push a cleared
    /// (SelectedDate == null) DatePicker value into a non-nullable
    /// DateTime source property, and by default that failure is SILENT
    /// (no revert, no autosave call, nothing the user can see). This
    /// handler is this DatePicker's own explicit backstop: whenever it
    /// goes null, force it back to the row's current (still-unchanged,
    /// since the binding never actually wrote through) Expiration value
    /// and surface why via the row's Save status column — same visible
    /// feedback path an actual failed PATCH already uses (row.SaveError),
    /// so no separate UI is needed for "this edit never even reached the
    /// server."
    ///
    /// Setting picker.SelectedDate back to a non-null value re-raises this
    /// same event, but the `picker.SelectedDate is not null` guard below
    /// makes that a one-shot no-op — no infinite loop.
    /// </summary>
    private void ExpirationDatePicker_OnSelectedDateChanged(object sender, SelectionChangedEventArgs e)
    {
        if (sender is not DatePicker { DataContext: LotRowViewModel row } picker) return;
        if (picker.SelectedDate is not null) return;

        picker.SelectedDate = row.Expiration;
        row.ReportValidationError("Expiration can't be blank — reverted to the last saved date.");
    }
}
