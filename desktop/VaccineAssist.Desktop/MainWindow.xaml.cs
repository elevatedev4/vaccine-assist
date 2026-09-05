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
    private readonly OrderingViewModel _orderingViewModel;
    private readonly EntryViewModel _entryViewModel;
    private readonly VaccinesViewModel _vaccinesViewModel;
    private readonly IAuthService _authService;
    private readonly IVaccineApiService _vaccineApiService;
    private readonly IClipboardService _clipboardService;
    private readonly IPioneerEntrySequence _pioneerEntrySequence;
    private GlobalHotKey? _dataEntryHotKey;

    /// <summary>
    /// The currently-open data-entry popup, if any — at most one can be
    /// open at a time (ShowDataEntryPopup doesn't check this; see that
    /// method's doc comment). Tracked so MainWindow can explicitly close
    /// it on sign-out/window-close (see MainWindow_OnClosed and
    /// LogoutButton_OnClick) now that it's no longer an owned window (see
    /// ShowDataEntryPopup's doc comment on removing Owner=this) — without
    /// this, the popup would survive past logout, left bound to a
    /// DataEntryPopupViewModel/IVaccineApiService whose bearer token is
    /// now stale (calls would just start 401ing). Cleared via the popup's
    /// own Closed event so a user closing it normally (or a second
    /// ShowDataEntryPopup call replacing it) doesn't leave a stale
    /// reference or cause a double-Close.
    /// </summary>
    private DataEntryPopupWindow? _openDataEntryPopup;

    /// <summary>Process-unique id for RegisterHotKey — arbitrary but must not collide with another hotkey id this process registers (only one exists today).</summary>
    private const int DataEntryHotKeyId = 1;

    public MainWindow(
        LotsViewModel lotsViewModel,
        VaccinesViewModel vaccinesViewModel,
        IAuthService authService,
        IVaccineApiService vaccineApiService,
        IClipboardService clipboardService,
        IPioneerEntrySequence pioneerEntrySequence)
    {
        InitializeComponent();
        _lotsViewModel = lotsViewModel;
        _vaccinesViewModel = vaccinesViewModel;
        _authService = authService;
        _vaccineApiService = vaccineApiService;
        _clipboardService = clipboardService;
        _pioneerEntrySequence = pioneerEntrySequence;

        _schedulingViewModel = new SchedulingViewModel(_vaccineApiService);
        _orderingViewModel = new OrderingViewModel(_vaccineApiService);
        _entryViewModel = new EntryViewModel(ShowDataEntryPopup, _clipboardService);

        SchedulingContent.Content = new SchedulingView(_schedulingViewModel);
        DataEntryTabContent.Content = new EntryView(_entryViewModel);
        LotsContent.Content = new LotsView(_lotsViewModel);
        // Active vaccines now hosts VaccinesView — adapted 2026-08-19 from
        // the old read-only catalog grid into the admin view (active +
        // inactive, "current lot" indicator, editable/persisted Active
        // toggle; see VaccinesViewModel).
        ActiveVaccinesContent.Content = new VaccinesView(_vaccinesViewModel);
        // Ordering — reorder recommendations from GET
        // /api/ordering/recommendation (see OrderingViewModel). Replaces
        // the static placeholder that used to live directly in
        // MainWindow.xaml.
        OrderingContent.Content = new OrderingView(_orderingViewModel);

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

        // Covers both exit paths: MainWindow closing directly (chrome/
        // Alt+F4) and Sign out (LogoutButton_OnClick -> App.xaml.cs's
        // LoggedOut handler calls mainWindow.Close(), which raises this
        // same Closed event) — see _openDataEntryPopup's doc comment for
        // why an orphaned popup is a real problem, not just cosmetic.
        _openDataEntryPopup?.Close();
        _openDataEntryPopup = null;
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

        // Tracked so MainWindow_OnClosed can explicitly close this popup
        // on sign-out/window-close rather than leaving it orphaned (see
        // _openDataEntryPopup's doc comment). If a popup from an earlier
        // hotkey press/button click is still open, this only replaces
        // the tracked reference — it does not close the old one first;
        // that's an existing, unchanged behavior (multiple popups can
        // stack), not something this lifecycle fix is scoped to change.
        popup.Closed += (_, _) =>
        {
            if (ReferenceEquals(_openDataEntryPopup, popup))
            {
                _openDataEntryPopup = null;
            }
        };
        _openDataEntryPopup = popup;

        popup.Show();
    }

    private async void LogoutButton_OnClick(object sender, RoutedEventArgs e)
    {
        await _authService.SignOutAsync();
        LoggedOut?.Invoke(this, EventArgs.Empty);
    }
}
