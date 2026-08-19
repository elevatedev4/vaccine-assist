using System.Windows.Controls;
using VaccineAssist.Desktop.ViewModels;

namespace VaccineAssist.Desktop.Views;

public partial class EntryView : UserControl
{
    public EntryView(EntryViewModel viewModel)
    {
        InitializeComponent();
        DataContext = viewModel;
    }
}
