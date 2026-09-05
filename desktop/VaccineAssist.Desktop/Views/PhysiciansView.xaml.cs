using System.Windows;
using System.Windows.Controls;
using VaccineAssist.Desktop.ViewModels;

namespace VaccineAssist.Desktop.Views;

public partial class PhysiciansView : UserControl
{
    private readonly PhysiciansViewModel _viewModel;

    public PhysiciansView(PhysiciansViewModel viewModel)
    {
        InitializeComponent();
        _viewModel = viewModel;
        DataContext = _viewModel;
    }

    private async void PhysiciansView_OnLoaded(object sender, RoutedEventArgs e)
    {
        await _viewModel.LoadAsync();
    }
}
