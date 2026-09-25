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
        // SystemParameters.WorkArea is always the PRIMARY monitor's work
        // area (existing limitation shared with MacroCodesWindow).
        var clampedSize = WindowSizing.ClampToWorkArea(
            Width, Height,
            SystemParameters.WorkArea.Width, SystemParameters.WorkArea.Height);
        Width = clampedSize.Width;
        Height = clampedSize.Height;

        // Reviewer fix (2026-09-25): this window's MinWidth/MinHeight
        // (720x440) are safely below its own clamped defaults in any
        // realistic case, but pin them through the same helper for
        // consistency with MainWindow — see WindowSizing.ClampMinimums's
        // doc comment for why MinWidth/MinHeight need this even though
        // ClampToWorkArea already ran above.
        var clampedMinSize = WindowSizing.ClampMinimums(MinWidth, MinHeight, clampedSize.Width, clampedSize.Height);
        MinWidth = clampedMinSize.MinWidth;
        MinHeight = clampedMinSize.MinHeight;
    }
}
