using System.Windows;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.ViewModels;

namespace VaccineAssist.Desktop.Views;

public partial class FaxRunSummaryWindow : Window
{
    public FaxRunSummaryWindow(FaxRunSummaryViewModel viewModel)
    {
        InitializeComponent();
        DataContext = viewModel;

        // 2026-09-25 (Will's screen-widths brief): clamp the XAML's
        // 960x620 default down to this monitor's work area minus a 40px
        // margin — same convention as Views/MacroCodesWindow.xaml.cs.
        var clampedSize = WindowSizing.ClampToWorkArea(
            Width, Height,
            SystemParameters.WorkArea.Width, SystemParameters.WorkArea.Height);
        Width = clampedSize.Width;
        Height = clampedSize.Height;
    }
}
