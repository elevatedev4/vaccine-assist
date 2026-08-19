using System;
using System.Windows;
using VaccineAssist.Desktop.Hotkeys;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.Services;
using VaccineAssist.Desktop.Uia;
using VaccineAssist.Desktop.ViewModels;
using VaccineAssist.Desktop.Views;

namespace VaccineAssist.Desktop;

/// <summary>
/// Shell hosting the three post-login screens. Navigation is plain
/// imperative code-behind (no navigation framework, no DataTemplate
/// view-model-first matching) — consistent with this app's DI-light,
/// manually-composed style (see App.xaml.cs).
///
/// Also owns the V-T3 global hotkey (Ctrl+NumPad2): registered here
/// (not a standalone window) since MainWindow is the one window that
/// stays open for the whole signed-in session — the hotkey should work
/// no matter which of the three nav screens is currently showing.
/// </summary>
public partial class MainWindow : Window
{
    private readonly VaccinesViewModel _vaccinesViewModel;
    private readonly LotsViewModel _lotsViewModel;
    private readonly EntryViewModel _entryViewModel;
    private readonly IAuthService _authService;
    private readonly IVaccineApiService _vaccineApiService;
    private readonly IClipboardService _clipboardService;
    private readonly IPioneerEntrySequence _pioneerEntrySequence;
    private GlobalHotKey? _dataEntryHotKey;

    /// <summary>Process-unique id for RegisterHotKey — arbitrary but must not collide with another hotkey id this process registers (only one exists today).</summary>
    private const int DataEntryHotKeyId = 1;

    public MainWindow(
        VaccinesViewModel vaccinesViewModel,
        LotsViewModel lotsViewModel,
        EntryViewModel entryViewModel,
        IAuthService authService,
        IVaccineApiService vaccineApiService,
        IClipboardService clipboardService,
        IPioneerEntrySequence pioneerEntrySequence)
    {
        InitializeComponent();
        _vaccinesViewModel = vaccinesViewModel;
        _lotsViewModel = lotsViewModel;
        _entryViewModel = entryViewModel;
        _authService = authService;
        _vaccineApiService = vaccineApiService;
        _clipboardService = clipboardService;
        _pioneerEntrySequence = pioneerEntrySequence;

        MainContent.Content = new VaccinesView(_vaccinesViewModel);

        SourceInitialized += MainWindow_OnSourceInitialized;
        Closed += MainWindow_OnClosed;
    }

    /// <summary>Raised after a successful sign-out — App.xaml.cs shows a
    /// fresh LoginWindow and closes this one.</summary>
    public event EventHandler? LoggedOut;

    /// <summary>
    /// Registers Ctrl+NumPad2 once this window has a native handle. A
    /// failed registration (e.g. another app already owns that
    /// combination) is surfaced once via a status-bar-free MessageBox
    /// rather than silently doing nothing — a hotkey that looks
    /// registered but never fires would be a confusing "the headline
    /// feature just doesn't work" bug report.
    /// </summary>
    private void MainWindow_OnSourceInitialized(object? sender, EventArgs e)
    {
        _dataEntryHotKey = new GlobalHotKey(this, DataEntryHotKeyId);
        _dataEntryHotKey.Pressed += (_, _) => ShowDataEntryPopup();

        if (!_dataEntryHotKey.Register())
        {
            MessageBox.Show(
                this,
                "Couldn't register the Ctrl+NumPad2 data-entry hotkey — it may already be in use by another application. " +
                "You can still use the Entry screen from the left nav.",
                "Vaccine Assist",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }
    }

    private void MainWindow_OnClosed(object? sender, EventArgs e)
    {
        _dataEntryHotKey?.Dispose();
        _dataEntryHotKey = null;
    }

    /// <summary>
    /// V-T3 item 2: light presence check first (Uia/PioneerRxPresence —
    /// cheap, no FlaUI/UIA session), then show the popup regardless of
    /// the result — a pharmacist who fat-fingers the hotkey before
    /// switching to PioneerRx still gets a usable popup (it defaults to
    /// dry run and says so; see DataEntryPopupViewModel's constructor)
    /// rather than nothing happening at all.
    /// </summary>
    private void ShowDataEntryPopup()
    {
        var pioneerDetected = PioneerRxPresence.IsPresent();
        var viewModel = new DataEntryPopupViewModel(_vaccineApiService, _clipboardService, _pioneerEntrySequence, pioneerDetected);
        var popup = new DataEntryPopupWindow(viewModel) { Owner = this };
        popup.Show();
    }

    private void VaccinesButton_OnClick(object sender, RoutedEventArgs e)
    {
        MainContent.Content = new VaccinesView(_vaccinesViewModel);
    }

    private void LotsButton_OnClick(object sender, RoutedEventArgs e)
    {
        MainContent.Content = new LotsView(_lotsViewModel);
    }

    private void EntryButton_OnClick(object sender, RoutedEventArgs e)
    {
        MainContent.Content = new EntryView(_entryViewModel);
    }

    private async void LogoutButton_OnClick(object sender, RoutedEventArgs e)
    {
        await _authService.SignOutAsync();
        LoggedOut?.Invoke(this, EventArgs.Empty);
    }
}
