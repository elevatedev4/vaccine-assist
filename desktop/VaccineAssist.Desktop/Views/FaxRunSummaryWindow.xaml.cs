using System.Windows;
using VaccineAssist.Desktop.ViewModels;

namespace VaccineAssist.Desktop.Views;

public partial class FaxRunSummaryWindow : Window
{
    public FaxRunSummaryWindow(FaxRunSummaryViewModel viewModel)
    {
        InitializeComponent();
        DataContext = viewModel;
    }
}
