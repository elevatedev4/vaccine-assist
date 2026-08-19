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
/// Shell hosting the five post-login tabs (Scheduling, Data entry, Lots,
/// Active vaccines, Ordering — see MainWindow.xaml). Navigation is a plain
/// TabControl; each tab's content is set once in the constructor via
/// imperative code-behind (no navigation framework, no DataTemplate
/// view-model-first matching) — consistent with this app's DI-light,
/// manually-composed style (see App.xaml.cs).
///
/// Also owns the V-T3 global hotkey (Ctrl+NumPad2): registered here
/// (not a standalone window) since MainWindow is the one window that
/// stays open for the whole signed-in session — the hotkey should work
/// no matter which tab is currently showing.
/// </summary>
public partial class MainWindow : Window
{
    private readonly LotsViewModel _lotsViewModel;
    private readonly SchedulingViewModel _schedulingViewModel;
    private readonly EntryViewModel _entryViewModel;
    private readonly IAuthService _authService;
    private readonly IVaccineApiService _vaccineApiService;
    private readonly IClipboardService _clipboardService;
    private readonly IPioneerEntrySequence _pioneerEntrySequence;
    private GlobalHotKey? _dataEntryHotKey;

    /// <summary>Process-unique id for RegisterHotKey — arbitrary but must not collide with another hotkey id this process registers (only one exists today).</summary>
    private const int DataEntryHotKeyId = 1;

    public MainWindow(
        LotsViewModel lotsViewModel,
        IAuthService authService,
        IVaccineApiService vaccineApiService,
        IClipboardService clipboardService,
        IPioneerEntrySequence pioneerEntrySequence)
    {
        InitializeComponent();
        _lotsViewModel = lotsViewModel;
        _authService = authService;
        _vaccineApiService = vaccineApiService;
        _clipboardService = clipboardService;
        _pioneerEntrySequence = pioneerEntrySequence;

        _schedulingViewModel = new SchedulingViewModel(_vaccineApiService);
        _entryViewModel = new EntryViewModel(ShowDataEntryPopup);

        SchedulingContent.Content = new SchedulingView(_schedulingViewModel);
        DataEntryTabContent.Content = new EntryView(_entryViewModel);
        LotsContent.Content = new LotsView(_lotsViewModel);
        // Active vaccines / Ordering tabs are static placeholder content
        // declared directly in MainWindow.xaml — nothing to wire here.
        //
        // VaccinesView/VaccinesViewModel (the old read-only catalog grid)
        // are deliberately NOT surfaced in any tab — Will asked for a
        // clean placeholder on "Active vaccines" instead, distinct from
        // that existing catalog view. Left untouched/unused in the repo
        // in case that content is wanted elsewhere later.

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
    /// feature just doesn't work" bug report. The same true/false result
    /// also drives the Data entry tab's status indicator (EntryViewModel.
    /// IsHotkeyActive) so it's visible without needing to reproduce the
    /// failure to notice it.
    /// </summary>
    private void MainWindow_OnSourceInitialized(object? sender, EventArgs e)
    {
        _dataEntryHotKey = new GlobalHotKey(this, DataEntryHotKeyId);
        _dataEntryHotKey.Pressed += (_, _) => ShowDataEntryPopup();

        var registered = _dataEntryHotKey.Register();
        _entryViewModel.IsHotkeyActive = registered;

        if (!registered)
        {
            MessageBox.Show(
                this,
                "Couldn't register the Ctrl+NumPad2 data-entry hotkey — it may already be in use by another application. " +
                "You can still open the popup from the Data entry tab.",
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
    ///
    /// Deliberately touches nothing on MainWindow itself — no Show,
    /// Activate, WindowState, or Visibility change, and no Owner
    /// assignment either. Will's feedback (2026-08-19): "don't make
    /// 'Vaccine Assist' pop up when data entry is happening, just the one
    /// popup window." MainWindow is already Show()n and visible as the
    /// normal app shell (it now hosts the 5 working tabs, so hiding it
    /// permanently per-session isn't right here), so the previous code's
    /// `Owner = this` on the popup was the actual bug: Win32 always keeps
    /// an owned window's owner above other non-owned windows in z-order,
    /// so showing the (Topmost, activated) popup also pulled MainWindow's
    /// z-position up along with it — visible as "Vaccine Assist popping
    /// up" if it had been sitting behind PioneerRx. The popup doesn't
    /// need Owner to stay on top of PioneerRx: it already sets
    /// Topmost="True" and ShowInTaskbar="False" itself (see
    /// DataEntryPopupWindow.xaml).
    /// </summary>
    private void ShowDataEntryPopup()
    {
        var pioneerDetected = PioneerRxPresence.IsPresent();
        var viewModel = new DataEntryPopupViewModel(_vaccineApiService, _clipboardService, _pioneerEntrySequence, pioneerDetected);
        var popup = new DataEntryPopupWindow(viewModel);
        popup.Show();
    }

    private async void LogoutButton_OnClick(object sender, RoutedEventArgs e)
    {
        await _authService.SignOutAsync();
        LoggedOut?.Invoke(this, EventArgs.Empty);
    }
}
