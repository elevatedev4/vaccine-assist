using System.Windows;
using System.Windows.Controls;
using VaccineAssist.Desktop.ViewModels;

namespace VaccineAssist.Desktop.Views;

/// <summary>
/// The Ordering tab. Fixed columns (Vaccine | Upcoming 7d | On hand (as
/// of date) | Recommended order) — unlike SchedulingView, there's no
/// dynamic per-vaccine column set here, so the DataGrid columns are
/// declared directly in XAML (see OrderingView.xaml), same as LotsView.
/// </summary>
public partial class OrderingView : UserControl
{
    private readonly OrderingViewModel _viewModel;

    public OrderingView(OrderingViewModel viewModel)
    {
        InitializeComponent();
        _viewModel = viewModel;
        DataContext = _viewModel;
    }

    private async void OrderingView_OnLoaded(object sender, RoutedEventArgs e)
    {
        await _viewModel.LoadAsync();
    }
}
