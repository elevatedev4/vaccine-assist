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
    /// (LotsView.xaml) against a USER clearing it. Originally written when
    /// LotRowViewModel.Expiration was a required, non-nullable DateTime —
    /// WPF's default TwoWay binding conversion couldn't push a cleared
    /// (SelectedDate == null) DatePicker value into that non-nullable
    /// source property, and by default that failure was SILENT (no
    /// revert, no autosave call, nothing the user could see).
    ///
    /// Expiration is now DateTime? (Will/lots-coder, 2026-09-16: the DB
    /// column itself is nullable — supabase/migrations/0014), so the
    /// binding itself no longer fails — a lot that simply LOADED with no
    /// expiration at all now shows correctly as a blank DatePicker with
    /// SelectedDate already null, and that must NOT trip this guard (it's
    /// not a "cleared" edit; there was nothing to revert to, and nothing
    /// the user did). Only an actual transition FROM a real date TO null —
    /// e.SelectedDate/e.RemovedItems still held one — is treated as an
    /// invalid clear; the "expiration is required for editing purposes"
    /// business rule itself is unchanged. `e.RemovedItems[0]` (the
    /// picker's own previous value at the moment of THIS change) is used
    /// to revert, rather than row.Expiration, since it reflects what was
    /// on screen before this specific change regardless of binding timing.
    ///
    /// Setting picker.SelectedDate back to a non-null value re-raises this
    /// same event, but the `picker.SelectedDate is not null` guard below
    /// makes that a one-shot no-op — no infinite loop.
    /// </summary>
    private void ExpirationDatePicker_OnSelectedDateChanged(object sender, SelectionChangedEventArgs e)
    {
        if (sender is not DatePicker { DataContext: LotRowViewModel row } picker) return;
        if (picker.SelectedDate is not null) return;
        if (e.RemovedItems.Count == 0 || e.RemovedItems[0] is not DateTime previousDate) return;

        picker.SelectedDate = previousDate;
        row.ReportValidationError("Expiration can't be blank — reverted to the last saved date.");
    }
}
