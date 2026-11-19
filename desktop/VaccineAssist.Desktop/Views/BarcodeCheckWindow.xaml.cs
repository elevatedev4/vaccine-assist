using System.Windows;
using System.Windows.Input;
using System.Windows.Threading;
using VaccineAssist.Desktop.BarcodeCheck;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Views;

/// <summary>
/// The "Barcode check" window (Will, 2026-11-18, MSG#1555). OpenFileDialog
/// and focus handling live here (same convention as FaxSendWindow); all
/// state and the matching live in BarcodeCheckViewModel. Closing the window
/// clears the view model, so the list is gone and a reopened window is
/// always blank.
/// </summary>
public partial class BarcodeCheckWindow : Window
{
    private readonly BarcodeCheckViewModel _viewModel;

    public BarcodeCheckWindow(BarcodeCheckViewModel viewModel)
    {
        InitializeComponent();
        _viewModel = viewModel;
        DataContext = viewModel;

        var clampedSize = WindowSizing.ClampToWorkArea(
            Width, Height,
            SystemParameters.WorkArea.Width, SystemParameters.WorkArea.Height);
        Width = clampedSize.Width;
        Height = clampedSize.Height;

        var clampedMinSize = WindowSizing.ClampMinimums(MinWidth, MinHeight, clampedSize.Width, clampedSize.Height);
        MinWidth = clampedMinSize.MinWidth;
        MinHeight = clampedMinSize.MinHeight;

        // The scanner types into this window, so whenever it comes back to
        // the front the scan box (if usable) gets the cursor again.
        Activated += (_, _) => FocusScanBox();
        Closed += (_, _) => _viewModel.Clear();
    }

    private async void ChooseFileButton_OnClick(object sender, RoutedEventArgs e)
    {
        try
        {
            var dialog = new Microsoft.Win32.OpenFileDialog
            {
                Title = "Choose a spreadsheet of numbers",
                Filter = "Spreadsheets (*.csv;*.xlsx;*.xls)|*.csv;*.xlsx;*.xls|All files (*.*)|*.*",
                CheckFileExists = true,
            };

            if (dialog.ShowDialog(this) != true)
            {
                return;
            }

            await _viewModel.LoadFileAsync(dialog.FileName);
            FocusScanBox();
        }
        catch (Exception ex)
        {
            // async void: nothing may escape to the Dispatcher backstop.
            AppFileLog.Log($"[BarcodeCheck] choose-file failed: {ex.GetType().Name}");
        }
    }

    private void ScanBox_OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Return)
        {
            return;
        }

        e.Handled = true;
        try
        {
            var scanned = ScanBox.Text;
            ScanBox.Clear();
            _viewModel.Scan(scanned);
        }
        catch (Exception ex)
        {
            AppFileLog.Log($"[BarcodeCheck] scan failed: {ex.GetType().Name}");
        }
    }

    private void CloseButton_OnClick(object sender, RoutedEventArgs e) => Close();

    private void FocusScanBox()
    {
        // Input priority: runs after bindings (IsEnabled) have applied.
        Dispatcher.BeginInvoke(DispatcherPriority.Input, new Action(() =>
        {
            if (ScanBox.IsEnabled)
            {
                ScanBox.Focus();
                Keyboard.Focus(ScanBox);
            }
        }));
    }
}
