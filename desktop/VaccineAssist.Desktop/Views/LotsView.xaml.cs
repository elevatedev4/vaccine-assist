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
}
