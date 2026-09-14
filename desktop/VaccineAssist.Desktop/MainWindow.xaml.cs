using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using VaccineAssist.Desktop.Hotkeys;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.Services;
using VaccineAssist.Desktop.Tray;
using VaccineAssist.Desktop.Uia;
using VaccineAssist.Desktop.ViewModels;
using VaccineAssist.Desktop.Views;

namespace VaccineAssist.Desktop;

/// <summary>
/// Shell hosting the six post-login tabs (Scheduling, Data entry, Lots,
/// Active vaccines, Ordering, Physicians — see MainWindow.xaml).
/// Navigation is a plain TabControl. Data entry is the only tab that
/// still hosts a native view (EntryView) — Will, 2026-09-13: "Make sure
/// data entry page is the main page that is shown" (see the XAML's
/// DataEntryTabItem.IsSelected). The other five host a CloudPageView
/// (WebView2 view of the matching cloud-app page) for cloud-parity,
/// built LAZILY the first time each tab is selected — see
/// MainTabs_OnSelectionChanged/EnsureCloudTabLoaded below and
/// Views/CloudPageView.xaml.cs's own doc comment.
///
/// Also owns the V-T3 global hotkey (Ctrl+NumPad7): registered here
/// (not a standalone window) since MainWindow is the one window that
/// stays open for the whole signed-in session — the hotkey should work
/// no matter which tab is currently showing.
///
/// 2026-09-13: also owns a second, independent global hotkey — Ctrl+Keypad 8 —
/// for the macro-codes popup (Will's brief). Same reasoning for living on
/// MainWindow as the data-entry hotkey above; the two GlobalHotKey
/// instances are otherwise unrelated (distinct ids, distinct vk, distinct
/// popups) and neither's registration/lifecycle affects the other's.
///
/// 2026-09-13 (tray): also owns a TrayIconController for the whole
/// signed-in session, same "one instance, lives as long as this window
/// does" reasoning as the hotkeys — Will: "have it be minimizable to the
/// tray so that the user can access it when needed. They will primarily
/// interact with it through hotkeys, so they'll just run it and minimize
/// it immediately." Minimizing OR clicking the window's Close button
/// both hide this window to the tray instead of tearing it down (see
/// MainWindow_OnStateChanged/MainWindow_OnClosing) so the global hotkeys
/// above keep working while hidden; only the tray menu's Exit (or
/// Sign out, which needs a real close so App.xaml.cs can show a fresh
/// LoginWindow) sets _allowRealClose and lets the window actually close.
/// </summary>
public partial class MainWindow : Window
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    private readonly EntryViewModel _entryViewModel;
    private readonly IAuthService _authService;
    private readonly IVaccineApiService _vaccineApiService;
    private readonly IClipboardService _clipboardService;
    private readonly IPioneerEntrySequence _pioneerEntrySequence;
    private readonly string _cloudApiBaseUrl;
    private readonly TrayIconController _trayIconController;
    private GlobalHotKey? _dataEntryHotKey;
    private GlobalHotKey? _macroCodesHotKey;

    /// <summary>
    /// Set right before a REAL close is wanted (the tray menu's Exit, or
    /// Sign out) — otherwise MainWindow_OnClosing intercepts the window's
    /// Close button and redirects it to the tray instead. See those two
    /// handlers and TrayIcon_OnExitRequested/SignOutAndRaiseLoggedOutAsync.
    /// </summary>
    private bool _allowRealClose;

    /// <summary>
    /// The currently-open data-entry popup, if any — at most one can be
    /// open at a time. MSG893 item 2 changed ShowDataEntryPopup to
    /// actively enforce that (re-activate/re-focus this instance instead
    /// of opening a second one) rather than merely tracking it; see that
    /// method's doc comment. Also lets MainWindow explicitly close it on
    /// sign-out/window-close (see MainWindow_OnClosed and
    /// LogoutButton_OnClick) now that it's no longer an owned window (see
    /// ShowDataEntryPopup's doc comment on removing Owner=this) — without
    /// this, the popup would survive past logout, left bound to a
    /// DataEntryPopupViewModel/IVaccineApiService whose bearer token is
    /// now stale (calls would just start 401ing). Cleared via the popup's
    /// own Closed event so a user closing it normally doesn't leave a
    /// stale reference or cause a double-Close.
    /// </summary>
    private DataEntryPopupWindow? _openDataEntryPopup;

    /// <summary>
    /// The currently-open macro-codes popup, if any — same "at most one at
    /// a time, re-activate rather than stack" rule as _openDataEntryPopup
    /// above (see ShowMacroCodesPopup), and same reason MainWindow needs
    /// to explicitly close it on sign-out/window-close (MainWindow_OnClosed):
    /// it's not an owned window, so nothing else would clean it up.
    /// </summary>
    private MacroCodesWindow? _openMacroCodesPopup;

    /// <summary>Process-unique id for RegisterHotKey — arbitrary but must not collide with another hotkey id this process registers.</summary>
    private const int DataEntryHotKeyId = 1;

    /// <summary>Process-unique id for the Ctrl+Keypad 8 macro-codes hotkey's RegisterHotKey call — must differ from DataEntryHotKeyId (the only other id this process registers).</summary>
    private const int MacroCodesHotKeyId = 2;

    public MainWindow(
        IAuthService authService,
        IVaccineApiService vaccineApiService,
        IClipboardService clipboardService,
        IPioneerEntrySequence pioneerEntrySequence,
        string cloudApiBaseUrl)
    {
        InitializeComponent();
        _authService = authService;
        _vaccineApiService = vaccineApiService;
        _clipboardService = clipboardService;
        _pioneerEntrySequence = pioneerEntrySequence;
        _cloudApiBaseUrl = cloudApiBaseUrl;

        _entryViewModel = new EntryViewModel(ShowDataEntryPopup, _clipboardService);
        DataEntryTabContent.Content = new EntryView(_entryViewModel);
        // Scheduling/Lots/Active vaccines/Ordering/Physicians are built
        // lazily by EnsureCloudTabLoaded, the first time each tab is
        // actually selected — see MainTabs_OnSelectionChanged.

        _trayIconController = new TrayIconController();
        _trayIconController.OpenRequested += (_, _) => RestoreFromTray();
        _trayIconController.SignOutRequested += async (_, _) => await SignOutAndRaiseLoggedOutAsync();
        _trayIconController.ExitRequested += (_, _) => ExitApplication();

        SourceInitialized += MainWindow_OnSourceInitialized;
        Closed += MainWindow_OnClosed;
        Closing += MainWindow_OnClosing;
        StateChanged += MainWindow_OnStateChanged;
    }

    /// <summary>Raised after a successful sign-out — App.xaml.cs shows a
    /// fresh LoginWindow and closes this one.</summary>
    public event EventHandler? LoggedOut;

    /// <summary>
    /// Registers Ctrl+NumPad7 once this window has a native handle. A
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
                "Couldn't register the Ctrl+NumPad7 data-entry hotkey — it may already be in use by another application. " +
                "You can still open the popup from the Data entry tab.",
                "Vaccine Assist",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }

        // 2026-09-13: Ctrl+Keypad 8 macro-codes popup — a second, independent
        // GlobalHotKey instance (distinct id, distinct vk) registered the
        // exact same way as the data-entry hotkey above, right down to the
        // failure handling (a one-time MessageBox; the popup just isn't
        // reachable via the hotkey if this fails — there's no separate
        // button for it the way the Data entry tab has one). Registration
        // is independent of window visibility, so this keeps working even
        // after the window is hidden to the tray.
        _macroCodesHotKey = new GlobalHotKey(this, MacroCodesHotKeyId, GlobalHotKey.VK_NUMPAD8);
        _macroCodesHotKey.Pressed += (_, _) => ShowMacroCodesPopup();

        var macroCodesRegistered = _macroCodesHotKey.Register();
        if (!macroCodesRegistered)
        {
            MessageBox.Show(
                this,
                "Couldn't register the Ctrl+Keypad 8 macro-codes hotkey — it may already be in use by another application.",
                "Vaccine Assist",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }
    }

    /// <summary>
    /// Will, 2026-09-13: "Minimize this window — it stays in the tray."
    /// Minimizing hides the window to the tray instead of leaving a
    /// minimized entry in the taskbar; the global hotkeys above keep
    /// working regardless (they don't depend on window visibility at
    /// all), which is the whole point — "they'll primarily interact with
    /// it through hotkeys, so they'll just run it and minimize it
    /// immediately."
    /// </summary>
    private void MainWindow_OnStateChanged(object? sender, EventArgs e)
    {
        if (WindowState == WindowState.Minimized)
        {
            HideToTray();
        }
    }

    /// <summary>
    /// Will, 2026-09-13: "Minimizing the window or clicking Close sends it
    /// to the tray (window hidden, app keeps running so the global
    /// hotkeys keep working); ... Exit truly exits." Intercepts the
    /// window chrome's Close button (and Alt+F4) and redirects to the
    /// tray UNLESS _allowRealClose was set first (the tray menu's Exit,
    /// or Sign out — see TrayIcon_OnExitRequested/
    /// SignOutAndRaiseLoggedOutAsync), in which case this lets the close
    /// proceed normally into MainWindow_OnClosed's cleanup.
    /// </summary>
    private void MainWindow_OnClosing(object? sender, CancelEventArgs e)
    {
        if (_allowRealClose)
        {
            return;
        }

        e.Cancel = true;
        HideToTray();
    }

    private void HideToTray()
    {
        Hide();
        if (WindowState == WindowState.Minimized)
        {
            // Reset to Normal WHILE hidden so RestoreFromTray doesn't
            // bring back a still-minimized window later.
            WindowState = WindowState.Normal;
        }
    }

    private void RestoreFromTray()
    {
        Show();
        WindowState = WindowState.Normal;
        Activate();
    }

    /// <summary>Tray menu's Exit — the one path that actually terminates
    /// the process. Closes this window first (with _allowRealClose set,
    /// so MainWindow_OnClosing lets it through and MainWindow_OnClosed's
    /// full cleanup — hotkeys, popups, the tray icon itself — runs) and
    /// then explicitly shuts the Application down: App.xaml's
    /// ShutdownMode="OnExplicitShutdown" means closing this window alone
    /// would NOT end the process on its own.</summary>
    private void ExitApplication()
    {
        _allowRealClose = true;
        Close();
        Application.Current.Shutdown();
    }

    /// <summary>
    /// Lazily builds the CloudPageView for one of the five cloud-parity
    /// tabs the first time it's actually selected — see this class's own
    /// doc comment and Views/CloudPageView.xaml.cs's. A no-op once
    /// content.Content is already set (never rebuilds/reloads on
    /// subsequent visits to an already-loaded tab).
    /// </summary>
    private void EnsureCloudTabLoaded(TabItem tabItem, ContentControl content, string relativePath)
    {
        if (!tabItem.IsSelected || content.Content is not null)
        {
            return;
        }

        content.Content = new CloudPageView(_cloudApiBaseUrl, relativePath);
    }

    /// <summary>
    /// TabControl.SelectionChanged is a routed event that bubbles up from
    /// any Selector-derived control living inside a tab's content (a
    /// ComboBox, ListBox, etc.) — this guard makes sure only an actual
    /// MainTabs selection change runs the lazy-load checks below, not
    /// some unrelated control inside whichever tab happens to be showing.
    /// Cloud routes here are the cloud app's REAL route folders (checked
    /// against cloud/app/*), which don't all match the tab names 1:1 —
    /// "Scheduling" is cloud's /appointments, for example.
    /// </summary>
    private void MainTabs_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!ReferenceEquals(e.OriginalSource, MainTabs))
        {
            return;
        }

        EnsureCloudTabLoaded(SchedulingTabItem, SchedulingContent, "/appointments");
        EnsureCloudTabLoaded(LotsTabItem, LotsContent, "/lots");
        EnsureCloudTabLoaded(ActiveVaccinesTabItem, ActiveVaccinesContent, "/vaccines");
        EnsureCloudTabLoaded(OrderingTabItem, OrderingContent, "/ordering");
        EnsureCloudTabLoaded(PhysiciansTabItem, PhysiciansContent, "/physicians");
    }

    private void MainWindow_OnClosed(object? sender, EventArgs e)
    {
        _dataEntryHotKey?.Dispose();
        _dataEntryHotKey = null;

        _macroCodesHotKey?.Dispose();
        _macroCodesHotKey = null;

        _trayIconController.Dispose();

        // Covers both exit paths: MainWindow closing directly (chrome/
        // Alt+F4, or the tray's Exit — both only reach here now via
        // _allowRealClose) and Sign out (LogoutButton_OnClick/tray Sign
        // out -> App.xaml.cs's LoggedOut handler calls mainWindow.Close(),
        // which raises this same Closed event) — see _openDataEntryPopup's
        // doc comment for why an orphaned popup is a real problem, not
        // just cosmetic.
        _openDataEntryPopup?.Close();
        _openDataEntryPopup = null;

        _openMacroCodesPopup?.Close();
        _openMacroCodesPopup = null;
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
    /// normal app shell (it now hosts the 6 working tabs, so hiding it
    /// permanently per-session isn't right here), so the previous code's
    /// `Owner = this` on the popup was the actual bug: Win32 always keeps
    /// an owned window's owner above other non-owned windows in z-order,
    /// so showing the (Topmost, activated) popup also pulled MainWindow's
    /// z-position up along with it — visible as "Vaccine Assist popping
    /// up" if it had been sitting behind PioneerRx. The popup doesn't
    /// need Owner to stay on top of PioneerRx: it already sets
    /// Topmost="True" and ShowInTaskbar="False" itself (see
    /// DataEntryPopupWindow.xaml). This also fires perfectly well while
    /// MainWindow is hidden to the tray — nothing here depends on
    /// MainWindow's own visibility.
    ///
    /// MSG893 item 2 (2026-09-07-ish): if the popup is ALREADY open (a
    /// repeat hotkey press, or the "Open data entry popup" button clicked
    /// again), re-activate and re-focus that SAME instance
    /// (DataEntryPopupWindow.ActivateAndFocusCurrentStage) instead of opening a
    /// second one — a pharmacist who presses the hotkey again because the
    /// first press didn't visibly grab focus should land back in the age
    /// box, not get a confusing stack of popups. This is a deliberate
    /// change from the previous "multiple popups can stack, unchanged"
    /// behavior.
    /// </summary>
    private void ShowDataEntryPopup()
    {
        if (_openDataEntryPopup is not null)
        {
            _openDataEntryPopup.ActivateAndFocusCurrentStage();
            return;
        }

        var pioneerDetected = PioneerRxPresence.IsPresent();
        var viewModel = new DataEntryPopupViewModel(_vaccineApiService, _clipboardService, _pioneerEntrySequence, pioneerDetected);
        var popup = new DataEntryPopupWindow(viewModel);

        // Tracked so MainWindow_OnClosed can explicitly close this popup
        // on sign-out/window-close (see _openDataEntryPopup's doc
        // comment), and so a repeat hotkey press above re-activates this
        // instance instead of opening a duplicate.
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

    /// <summary>
    /// Ctrl+Keypad 8 (Will, 2026-09-13). Same "at most one instance, re-activate
    /// instead of stacking" rule as ShowDataEntryPopup above — see
    /// _openMacroCodesPopup's doc comment. Captures the current foreground
    /// window (typically PioneerRx, if that's what the pharmacist was
    /// working in) via GetForegroundWindow() BEFORE showing the popup, so
    /// MacroCodesWindow can restore it on close — see that window's
    /// constructor/Closed handler. Works fine while MainWindow itself is
    /// hidden to the tray, same as ShowDataEntryPopup.
    /// </summary>
    private void ShowMacroCodesPopup()
    {
        if (_openMacroCodesPopup is not null)
        {
            _openMacroCodesPopup.BringToFront();
            return;
        }

        var previousForegroundWindow = GetForegroundWindow();
        var popup = new MacroCodesWindow(_cloudApiBaseUrl, _clipboardService, previousForegroundWindow);

        popup.Closed += (_, _) =>
        {
            if (ReferenceEquals(_openMacroCodesPopup, popup))
            {
                _openMacroCodesPopup = null;
            }
        };
        _openMacroCodesPopup = popup;

        popup.Show();
    }

    private async void LogoutButton_OnClick(object sender, RoutedEventArgs e) => await SignOutAndRaiseLoggedOutAsync();

    /// <summary>
    /// Shared by the visible "Sign out" button AND the tray menu's Sign
    /// out item — both need the exact same real-close-then-LoggedOut
    /// sequence, whether the window is currently visible or hidden in
    /// the tray. _allowRealClose is set FIRST so App.xaml.cs's LoggedOut
    /// handler (which calls mainWindow.Close()) isn't intercepted by
    /// MainWindow_OnClosing and redirected back to the tray.
    /// </summary>
    private async System.Threading.Tasks.Task SignOutAndRaiseLoggedOutAsync()
    {
        _allowRealClose = true;
        await _authService.SignOutAsync();
        LoggedOut?.Invoke(this, EventArgs.Empty);
    }
}
