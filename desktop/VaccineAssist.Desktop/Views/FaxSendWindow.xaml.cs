using System.Windows;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.ViewModels;

namespace VaccineAssist.Desktop.Views;

/// <summary>
/// V-T65 R4 (Will, verbatim, 2026-09-29): "have that open a dialogue
/// window where you can selec tht efile then push send then see the
/// results below." OpenFileDialog lives here (not the ViewModel — same
/// convention as the old MainWindow.ImportReportFileAndSendAsync) since
/// it needs a real Window as its owner; everything after the file is
/// picked (Send, results, retry) is FaxSendViewModel's job.
/// </summary>
public partial class FaxSendWindow : Window
{
    private readonly FaxSendViewModel _viewModel;

    public FaxSendWindow(FaxSendViewModel viewModel)
    {
        InitializeComponent();
        _viewModel = viewModel;
        DataContext = viewModel;

        // Same clamp-to-work-area convention as the old FaxRunSummaryWindow.
        var clampedSize = WindowSizing.ClampToWorkArea(
            Width, Height,
            SystemParameters.WorkArea.Width, SystemParameters.WorkArea.Height);
        Width = clampedSize.Width;
        Height = clampedSize.Height;

        var clampedMinSize = WindowSizing.ClampMinimums(MinWidth, MinHeight, clampedSize.Width, clampedSize.Height);
        MinWidth = clampedMinSize.MinWidth;
        MinHeight = clampedMinSize.MinHeight;
    }

    private void ChooseFileButton_OnClick(object sender, RoutedEventArgs e)
    {
        var dialog = new Microsoft.Win32.OpenFileDialog
        {
            Title = "Choose an immunization report",
            Filter = "Immunization reports (*.csv;*.xlsx)|*.csv;*.xlsx|All files (*.*)|*.*",
            CheckFileExists = true,
        };

        if (dialog.ShowDialog(this) == true)
        {
            _viewModel.SetChosenFile(dialog.FileName);
        }
    }
}
