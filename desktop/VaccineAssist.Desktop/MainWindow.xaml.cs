using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Windows;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Fax;
using VaccineAssist.Desktop.Hotkeys;
using VaccineAssist.Desktop.Logging;
using VaccineAssist.Desktop.Overlay;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.Services;
using VaccineAssist.Desktop.Settings;
using VaccineAssist.Desktop.Tray;
using VaccineAssist.Desktop.Uia;
using VaccineAssist.Desktop.ViewModels;
using VaccineAssist.Desktop.Views;

namespace VaccineAssist.Desktop;

/// <summary>
/// Shell hosting the signed-in session — see MainWindow.xaml's own doc
/// comment for the V-T-single-nav change (one CloudPageView, full window,
/// no native TabControl). This class still owns everything that must
/// live for the WHOLE signed-in session regardless of which cloud route
/// is currently showing: the three global hotkeys (Ctrl+NumPad7 data
/// entry, Ctrl+Keypad 8 macro codes, Ctrl+Keypad 2 age-filtered macro
/// codes), the tray icon, the data-entry/macro-codes popups, and (new,
/// Part 4) the Pioneer overlay icon.
///
/// Also owns the V-T3 global hotkey (Ctrl+NumPad7): registered here
/// (not a standalone window) since MainWindow is the one window that
/// stays open for the whole signed-in session — the hotkey should work
/// no matter which cloud route is currently showing.
///
/// 2026-09-13: also owns a second, independent global hotkey — Ctrl+Keypad 8 —
/// for the macro-codes popup (Will's brief). Same reasoning for living on
/// MainWindow as the data-entry hotkey above; the two GlobalHotKey
/// instances are otherwise unrelated (distinct ids, distinct vk, distinct
/// popups) and neither's registration/lifecycle affects the other's.
///
/// 2026-09-25: also owns a third, independent global hotkey — originally
/// Ctrl+Keypad 4 — for the age-filtered macro-codes flow (Will's brief,
/// verbatim: "Add new hotkey Ctrl+Keypad 4 that shows a screen to enter
/// patient age, then shows the macro codes page filtered..."). Same
/// reasoning/independence as the other two; see ShowAgeMacroPrompt.
///
/// 2026-09-25 round 2 (Will, verbatim): "Fro the new ctrl+keypad 4 item,
/// make it ctrl+keypad 2 to start it and then it runs the macro at the
/// end with ctrl + keypad 5." Re-keyed same-day: this third hotkey is now
/// Ctrl+Keypad 2 (VK_NUMPAD2) instead of Ctrl+Keypad 4, and the synthetic
/// keypress it sends once a code is copied is now Ctrl+Keypad 5 instead
/// of Ctrl+Keypad 2 — see GlobalHotKey.VK_NUMPAD2's doc comment for why
/// Ctrl+NumPad2 is safe to register as a hotkey again despite the MSG893
/// history, and MacroCodesWindow's sendCtrlNumPad5OnClose for the
/// synthetic-keypress side.
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
///
/// 2026-09-14 (Part 4): also owns a PioneerOverlayController for the same
/// "whole signed-in session, survives being hidden to the tray" lifetime —
/// see that class's own doc comment.
/// </summary>
public partial class MainWindow : Window
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    private readonly IAuthService _authService;
    private readonly IVaccineApiService _vaccineApiService;
    private readonly IClipboardService _clipboardService;
    private readonly IPioneerEntrySequence _pioneerEntrySequence;
    private readonly ILocalSettingsService _localSettingsService;
    private readonly AppSettings _settings;
    private readonly CloudPageView _cloudPageView;

    /// <summary>V-T53 (vaccine -> PCP fax): owns the daily-run/receipt-poll
    /// timers for the whole signed-in session — same lifetime pattern as
    /// _pioneerOverlayController (Start() on Loaded, Dispose() on Closed).</summary>
    private readonly FaxRunScheduler _faxRunScheduler;
    private readonly FaxRunOrchestrator _faxRunOrchestrator;
    private readonly IFaxCredentialStore _faxCredentialStore;
    private readonly IPrescriberDirectory _prescriberDirectory;
    private readonly HttpClient _faxHttpClient;

    /// <summary>At most one Fax settings window at a time — same
    /// re-activate-not-stack rule as _openDataEntryPopup/_openMacroCodesPopup.</summary>
    private FaxSettingsWindow? _openFaxSettingsWindow;

    /// <summary>
    /// BUG FIX (Will, 2026-09-14): null when TrayIconController's
    /// constructor (WinForms NotifyIcon + ContextMenuStrip) throws — e.g. a
    /// locked-down workstation where the shell notification area isn't
    /// available. Previously that exception was unguarded and would blow
    /// up MainWindow's own constructor, which (called from App.xaml.cs's
    /// StartSignInFlowAsync) meant the "Signing in…" splash's Close() line
    /// right after was never reached — the splash was left on screen
    /// forever with no window to replace it. Every use site below is
    /// null-guarded, and the minimize/close-to-tray behavior is skipped
    /// entirely when this is null (see MainWindow_OnStateChanged/
    /// MainWindow_OnClosing) — there'd be no tray icon to restore the
    /// window from, so hiding it would strand the user instead of merely
    /// losing a convenience feature.
    /// </summary>
    private readonly TrayIconController? _trayIconController;

    /// <summary>Part 4 — null if construction ever throws (belt-and-suspenders, same posture as _trayIconController above); a missing overlay just means no Pioneer icon, never a broken MainWindow.</summary>
    private readonly PioneerOverlayController? _pioneerOverlayController;

    private GlobalHotKey? _dataEntryHotKey;
    private GlobalHotKey? _macroCodesHotKey;
    private GlobalHotKey? _ageMacroHotKey;

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

    /// <summary>
    /// 2026-09-25: the currently-open age-macro popup, if any — same
    /// "at most one at a time, re-activate rather than stack" rule as
    /// _openMacroCodesPopup above, but tracked separately (not sharing
    /// that field) so this new Ctrl+Keypad 2 flow (originally Ctrl+Keypad
    /// 4 — see the class doc comment's round-2 note) can't interfere with
    /// the existing Ctrl+Keypad 8 popup's own single-instance bookkeeping.
    /// Both fields can be non-null at the same time (a pharmacist could,
    /// in principle, have one of each open); MainWindow_OnClosed closes
    /// both explicitly on sign-out/window-close for the same reason
    /// _openMacroCodesPopup's doc comment gives.
    /// </summary>
    private MacroCodesWindow? _openAgeMacroPopup;

    /// <summary>
    /// True only while AgePromptWindow.ShowAndGetResult's modal ShowDialog
    /// is up (see ShowAgeMacroPrompt). ShowDialog runs its own nested
    /// message loop, which still dispatches this app's WM_HOTKEY messages
    /// — so a repeat Ctrl+Keypad 2 press WHILE the age prompt is already
    /// showing would otherwise re-enter ShowAgeMacroPrompt and stack a
    /// second AgePromptWindow on top of the first (_openAgeMacroPopup is
    /// still null at that point; it's only set once a code-copy flow
    /// actually opens a MacroCodesWindow). This flag closes that gap.
    /// </summary>
    private bool _ageMacroPromptShowing;

    /// <summary>Process-unique id for RegisterHotKey — arbitrary but must not collide with another hotkey id this process registers.</summary>
    private const int DataEntryHotKeyId = 1;

    /// <summary>Process-unique id for the Ctrl+Keypad 8 macro-codes hotkey's RegisterHotKey call — must differ from DataEntryHotKeyId (the only other id this process registers).</summary>
    private const int MacroCodesHotKeyId = 2;

    /// <summary>Process-unique id for the Ctrl+Keypad 2 age-macro hotkey's RegisterHotKey call (originally Ctrl+Keypad 4 — re-keyed 2026-09-25 round 2) — must differ from DataEntryHotKeyId/MacroCodesHotKeyId (the only other ids this process registers).</summary>
    private const int AgeMacroHotKeyId = 3;

    /// <param name="cloudPageView">
    /// A freshly-constructed, NOT-yet-initialized CloudPageView (see its
    /// autoInitializeOnLoad: false constructor argument) — App.xaml.cs's
    /// ShowMainWindowAndInitializeAsync hosts it here and calls Show() on
    /// THIS window BEFORE running WebView2 init/the cloud sign-in handoff,
    /// not after (ORDERING FIX, Will's app.log, 2026-09-16: a WPF WebView2
    /// control can't create its CoreWebView2Controller until it has a
    /// parent HWND, i.e. until the window hosting it has actually been
    /// shown — see that method's own doc comment for the full diagnosis).
    /// MainWindow itself never creates its own CloudPageView — it just
    /// hosts the one it's handed, blank at first, then showing "/" once
    /// App.xaml.cs's init+handoff finishes.
    /// </param>
    public MainWindow(
        IAuthService authService,
        IVaccineApiService vaccineApiService,
        IClipboardService clipboardService,
        IPioneerEntrySequence pioneerEntrySequence,
        CloudPageView cloudPageView,
        ILocalSettingsService localSettingsService,
        AppSettings settings,
        FaxRunScheduler faxRunScheduler,
        FaxRunOrchestrator faxRunOrchestrator,
        IFaxCredentialStore faxCredentialStore,
        IPrescriberDirectory prescriberDirectory,
        HttpClient faxHttpClient)
    {
        _authService = authService;
        _vaccineApiService = vaccineApiService;
        _clipboardService = clipboardService;
        _pioneerEntrySequence = pioneerEntrySequence;
        _cloudPageView = cloudPageView;
        _localSettingsService = localSettingsService;
        _settings = settings;
        _faxRunScheduler = faxRunScheduler;
        _faxRunOrchestrator = faxRunOrchestrator;
        _faxCredentialStore = faxCredentialStore;
        _prescriberDirectory = prescriberDirectory;
        _faxHttpClient = faxHttpClient;

        InitializeComponent();

        // 2026-09-25 (Will, verbatim: "make sure the widths of all the
        // screens are enough ... it wasn't wide enough. It was maing the
        // tables all cramped"): clamp the XAML's larger 1600x900 default
        // DOWN to this monitor's actual work area (minus a 40px margin,
        // same convention as Views/MacroCodesWindow.xaml.cs) so a smaller
        // screen never gets an oversized, off-screen window. Must run
        // before Show() — App.xaml.cs's ShowMainWindowAndInitializeAsync
        // calls Show() right after constructing this window — so
        // WindowStartupLocation="CenterScreen" still centers against the
        // clamped size. SystemParameters.WorkArea is always the PRIMARY
        // monitor's work area (same existing limitation MacroCodesWindow
        // already has) — fine here since this is the app's one main
        // window, always opened on the primary display.
        var clampedSize = WindowSizing.ClampToWorkArea(
            Width, Height,
            SystemParameters.WorkArea.Width, SystemParameters.WorkArea.Height);
        Width = clampedSize.Width;
        Height = clampedSize.Height;

        // Reviewer fix (2026-09-25): MinWidth/MinHeight are hard floors in
        // WPF — ClampToWorkArea above only touches the default Width/
        // Height, so without this a MinWidth of 1100 would still force the
        // window past a smaller work area (e.g. 1024x768 over RDP/Citrix:
        // clampedSize.Width is 984, but MinWidth stayed 1100 and won). Pin
        // the minimums down to the clamped size too, never below
        // WindowSizing's absolute usability floor.
        var clampedMinSize = WindowSizing.ClampMinimums(MinWidth, MinHeight, clampedSize.Width, clampedSize.Height);
        MinWidth = clampedMinSize.MinWidth;
        MinHeight = clampedMinSize.MinHeight;

        MainContent.Content = _cloudPageView;

        _faxRunScheduler.RunCompleted += FaxRunScheduler_OnRunCompleted;
        // Reviewer fix (V-T53): tray "Run now" while a run is already in
        // flight must say so instead of silently doing nothing.
        _faxRunScheduler.RunAlreadyInProgress += (_, _) => _trayIconController?.ShowBalloonTip(
            "Vaccine faxes", "A run is already in progress.");

        try
        {
            var trayIconController = new TrayIconController(_settings.ShowPioneerOverlay);
            trayIconController.OpenRequested += (_, _) => RestoreFromTray();
            trayIconController.SignOutRequested += async (_, _) => await SignOutAndRaiseLoggedOutAsync();
            trayIconController.ExitRequested += (_, _) => ExitApplication();
            trayIconController.DataEntryRequested += (_, _) => ShowDataEntryPopup();
            trayIconController.MacroCodesRequested += (_, _) => ShowMacroCodesPopup();
            trayIconController.NavigationRequested += (_, path) => NavigateTo(path);
            trayIconController.ShowOverlayToggled += (_, isChecked) => SetShowPioneerOverlay(isChecked);
            trayIconController.FaxRunNowRequested += async (_, _) => await _faxRunScheduler.RunNowAsync();
            trayIconController.FaxSettingsRequested += (_, _) => ShowFaxSettings();
            trayIconController.FaxOpenFolderRequested += (_, _) => OpenFaxFolder();
            trayIconController.FaxImportFileRequested += async (_, _) => await ImportReportFileAndRunAsync();
            _trayIconController = trayIconController;
        }
        catch (Exception ex)
        {
            // See _trayIconController's doc comment — MainWindow must still
            // open (with no tray icon/minimize-to-tray) rather than fail.
            AppFileLog.LogException("MainWindow.TrayIconController", ex);
            _trayIconController = null;
        }

        try
        {
            _pioneerOverlayController = new PioneerOverlayController(
                navigateTo: NavigateTo,
                showDataEntryPopup: ShowDataEntryPopup,
                showMacroCodesPopup: ShowMacroCodesPopup,
                exit: ExitApplication,
                settings: _settings);
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("MainWindow.PioneerOverlayController", ex);
            _pioneerOverlayController = null;
        }

        SourceInitialized += MainWindow_OnSourceInitialized;
        Loaded += MainWindow_OnLoaded;
        Closed += MainWindow_OnClosed;
        Closing += MainWindow_OnClosing;
        StateChanged += MainWindow_OnStateChanged;
    }

    /// <summary>Raised after a successful sign-out — App.xaml.cs shows a
    /// fresh LoginWindow and closes this one.</summary>
    public event EventHandler? LoggedOut;

    /// <summary>
    /// Part 2/3 (Will's brief): restores this window from the tray if
    /// hidden, brings it to front, and navigates the single WebView2 to a
    /// cloud route — shared by the tray menu's nav items and the Pioneer
    /// overlay icon's menu (both raise the same relative path; see
    /// Navigation/AppNavigationItems.cs).
    /// </summary>
    public void NavigateTo(string relativePath)
    {
        RestoreFromTray();
        _cloudPageView.NavigateToPath(relativePath);
    }

    /// <summary>
    /// Part 3's checkable "Show Pioneer overlay" tray row — persists the
    /// new state to settings.json immediately (same "settings changes
    /// save right away" convention as everywhere else in this app) and
    /// lets PioneerOverlayController's own next ~250ms tick pick up the
    /// change (it reads _settings.ShowPioneerOverlay directly, so no
    /// separate notification is needed).
    /// </summary>
    private void SetShowPioneerOverlay(bool isChecked)
    {
        _settings.ShowPioneerOverlay = isChecked;
        try
        {
            _localSettingsService.Save(_settings);
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("MainWindow.SetShowPioneerOverlay", ex);
        }
    }

    /// <summary>
    /// Registers Ctrl+NumPad7 once this window has a native handle. A
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

        var registered = _dataEntryHotKey.Register();
        if (!registered)
        {
            MessageBox.Show(
                this,
                "Couldn't register the Ctrl+NumPad7 data-entry hotkey — it may already be in use by another application. " +
                "You can still open the popup from the tray menu or the Pioneer overlay icon.",
                "Vaccine Assist",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }

        // 2026-09-13: Ctrl+Keypad 8 macro-codes popup — a second, independent
        // GlobalHotKey instance (distinct id, distinct vk) registered the
        // exact same way as the data-entry hotkey above, right down to the
        // failure handling (a one-time MessageBox; the popup just isn't
        // reachable via the hotkey if this fails — the tray menu/overlay
        // icon still open it). Registration is independent of window
        // visibility, so this keeps working even after the window is
        // hidden to the tray.
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

        // 2026-09-25: age-macro flow — a third, independent GlobalHotKey
        // instance (distinct id, distinct vk), same registration/
        // failure-handling pattern as the two above. Round 2 (Will,
        // verbatim, same day): "Fro the new ctrl+keypad 4 item, make it
        // ctrl+keypad 2 to start it" — re-keyed from VK_NUMPAD4 to
        // VK_NUMPAD2 before this ever shipped; see GlobalHotKey.VK_NUMPAD2's
        // doc comment for why Ctrl+NumPad2 is safe to register again
        // despite the MSG893 history.
        _ageMacroHotKey = new GlobalHotKey(this, AgeMacroHotKeyId, GlobalHotKey.VK_NUMPAD2);
        _ageMacroHotKey.Pressed += (_, _) => ShowAgeMacroPrompt();

        var ageMacroRegistered = _ageMacroHotKey.Register();
        if (!ageMacroRegistered)
        {
            MessageBox.Show(
                this,
                "Couldn't register the Ctrl+Keypad 2 age-macro hotkey — it may already be in use by another application.",
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
        // No tray icon to restore from if TrayIconController failed to
        // construct (see its field doc comment) — a normal minimize is
        // safer than hiding to a tray the user can never bring back.
        if (WindowState == WindowState.Minimized && _trayIconController is not null)
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
        // Same "no tray icon to restore from" reasoning as
        // MainWindow_OnStateChanged above — without a tray, redirecting a
        // real close to Hide() would strand the user with no visible
        // window and no way to bring it back, so let the close (and the
        // resulting Shutdown in MainWindow_OnClosed) proceed instead.
        if (_allowRealClose || _trayIconController is null)
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
    /// V-T-single-nav: the 2026-09-14 "SelectionChanged fires mid-
    /// InitializeComponent" bug-fix machinery (MainWindowTabSelectionPolicy/
    /// EnsureCloudTabLoaded) is gone entirely along with the TabControl it
    /// guarded — there's no SelectionChanged event left to fire early.
    /// Starts the Pioneer overlay controller once this window (and
    /// therefore the whole signed-in session) is actually up.
    /// </summary>
    private void MainWindow_OnLoaded(object sender, RoutedEventArgs e)
    {
        _pioneerOverlayController?.Start();
        _faxRunScheduler.Start();
    }

    private void MainWindow_OnClosed(object? sender, EventArgs e)
    {
        _dataEntryHotKey?.Dispose();
        _dataEntryHotKey = null;

        _macroCodesHotKey?.Dispose();
        _macroCodesHotKey = null;

        _ageMacroHotKey?.Dispose();
        _ageMacroHotKey = null;

        _trayIconController?.Dispose();
        _pioneerOverlayController?.Dispose();
        _faxRunScheduler.Dispose();

        _openFaxSettingsWindow?.Close();
        _openFaxSettingsWindow = null;

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

        _openAgeMacroPopup?.Close();
        _openAgeMacroPopup = null;
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
    /// popup window." The popup doesn't need Owner to stay on top of
    /// PioneerRx: it already sets Topmost="True" and ShowInTaskbar="False"
    /// itself (see DataEntryPopupWindow.xaml). This also fires perfectly
    /// well while MainWindow is hidden to the tray — nothing here depends
    /// on MainWindow's own visibility.
    ///
    /// MSG893 item 2 (2026-09-07-ish): if the popup is ALREADY open (a
    /// repeat hotkey press, or the tray/overlay's "Data entry" item
    /// clicked again), re-activate and re-focus that SAME instance
    /// (DataEntryPopupWindow.ActivateAndFocusCurrentStage) instead of opening a
    /// second one — a pharmacist who presses the hotkey again because the
    /// first press didn't visibly grab focus should land back in the age
    /// box, not get a confusing stack of popups.
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
        var popup = new MacroCodesWindow(_settings.CloudApiBaseUrl, _clipboardService, previousForegroundWindow);

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

    /// <summary>
    /// Originally Ctrl+Keypad 4 (Will, 2026-09-25, verbatim): "Add new
    /// hotkey Ctrl+Keypad 4 that shows a screen to enter patient age, then
    /// shows the macro codes page filtered to only show vaccines suitable
    /// for their age range, then when someone clicks the macro code, it
    /// copies the code, closes that screen, and pushes Ctrl+Keypad 2,
    /// which will activate our on-computer macro. The macro will take
    /// care of the rest." Same "at most one instance, re-activate instead
    /// of stacking" rule as ShowMacroCodesPopup above — see
    /// _openAgeMacroPopup's doc comment.
    ///
    /// Round 2, same day (Will, verbatim): "Fro the new ctrl+keypad 4
    /// item, make it ctrl+keypad 2 to start it and then it runs the macro
    /// at the end with ctrl + keypad 5." So the hotkey that reaches this
    /// method is now Ctrl+Keypad 2 (see MainWindow's _ageMacroHotKey), and
    /// the synthetic keypress MacroCodesWindow sends once a code is
    /// copied is now Ctrl+Keypad 5 (see sendCtrlNumPad5OnClose below) —
    /// not the Ctrl+Keypad 2 the original brief described, which would
    /// now collide with this very hotkey.
    ///
    /// Captures the foreground window BEFORE showing the age prompt (not
    /// after, and not right before opening the macro-codes window) so
    /// whatever the pharmacist was doing (typically PioneerRx) — not this
    /// app's own AgePromptWindow — is what gets restored once a code is
    /// copied; see MacroCodesWindow's previousForegroundWindow parameter
    /// and MacroCodesWindow_OnClosed.
    ///
    /// AgePromptWindow.ShowAndGetResult is modal (ShowDialog) — reached
    /// directly from the hotkey's Pressed event (itself raised
    /// synchronously from GlobalHotKey.WndProc), same posture as the
    /// other two hotkey handlers above, which also do their popup
    /// creation/showing synchronously on this callback.
    /// </summary>
    private void ShowAgeMacroPrompt()
    {
        if (_openAgeMacroPopup is not null)
        {
            _openAgeMacroPopup.BringToFront();
            return;
        }

        if (_ageMacroPromptShowing)
        {
            return;
        }

        AppFileLog.Log("[AgeMacro] prompt");

        var previousForegroundWindow = GetForegroundWindow();
        AgePromptResult result;
        _ageMacroPromptShowing = true;
        try
        {
            result = AgePromptWindow.ShowAndGetResult();
        }
        finally
        {
            _ageMacroPromptShowing = false;
        }

        if (!result.Confirmed)
        {
            AppFileLog.Log("[AgeMacro] cancelled");
            return;
        }

        AppFileLog.Log($"[AgeMacro] age {result.Years}");

        var url = AgeMacroCodesUrlBuilder.BuildUrl(_settings.CloudApiBaseUrl, result.Years);
        var popup = new MacroCodesWindow(
            _settings.CloudApiBaseUrl,
            _clipboardService,
            previousForegroundWindow,
            overrideUrl: url,
            sendCtrlNumPad5OnClose: true);

        popup.Closed += (_, _) =>
        {
            if (ReferenceEquals(_openAgeMacroPopup, popup))
            {
                _openAgeMacroPopup = null;
            }
        };
        _openAgeMacroPopup = popup;

        AppFileLog.Log("[AgeMacro] opened");
        popup.Show();
    }

    /// <summary>V-T53: tray menu's "Vaccine faxes — Settings" — same
    /// at-most-one-instance/re-activate rule as the data-entry/macro-codes
    /// popups.</summary>
    private void ShowFaxSettings()
    {
        if (_openFaxSettingsWindow is not null)
        {
            _openFaxSettingsWindow.Activate();
            return;
        }

        var viewModel = new FaxSettingsViewModel(_settings, _localSettingsService, _faxCredentialStore, _prescriberDirectory, _faxHttpClient);
        var window = new FaxSettingsWindow(viewModel);
        window.Closed += (_, _) =>
        {
            if (ReferenceEquals(_openFaxSettingsWindow, window))
            {
                _openFaxSettingsWindow = null;
            }
        };
        _openFaxSettingsWindow = window;
        window.Show();
    }

    /// <summary>V-T53: tray menu's "Open fax folder" — the shared
    /// %AppData%\VaccineAssist\fax\ root (outbox/sent/failed/runs/
    /// ledger.json/prescribers.json all live under it).</summary>
    private void OpenFaxFolder()
    {
        try
        {
            var faxDir = System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "VaccineAssist", "fax");
            System.IO.Directory.CreateDirectory(faxDir);
            Process.Start(new ProcessStartInfo("explorer.exe", $"\"{faxDir}\"") { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("MainWindow.OpenFaxFolder", ex);
        }
    }

    /// <summary>
    /// 2026-09-22 (Will, verbatim): "A user will import the report into the
    /// app directly" — no SFTP drop, no cloud pull. Opens a file picker for
    /// a CSV/XLSX report, copies it into the configured Fax.InputFolder
    /// (Fax/FaxImportFileCopier.cs — the pure/testable half of this), then
    /// runs the SAME RunNowAsync path "Run now" already uses — the copied
    /// file is picked up by the normal ReportImporter folder scan, so
    /// nothing about import/dedup/PDF/queue/ledger/summary-window needed to
    /// change for this to work. Cancelling the file picker is a silent
    /// no-op; a copy failure (most commonly: no input folder configured
    /// yet) surfaces via MessageBox, same pattern as the hotkey-registration
    /// failures in MainWindow_OnSourceInitialized above, since this is a
    /// directly user-triggered action that just showed a dialog — a silent
    /// failure here would look like the click did nothing.
    /// </summary>
    private async System.Threading.Tasks.Task ImportReportFileAndRunAsync()
    {
        var dialog = new Microsoft.Win32.OpenFileDialog
        {
            Title = "Import immunization report",
            Filter = "Immunization reports (*.csv;*.xlsx)|*.csv;*.xlsx|All files (*.*)|*.*",
            CheckFileExists = true,
        };

        if (dialog.ShowDialog(this) != true)
        {
            return;
        }

        try
        {
            FaxImportFileCopier.CopyIntoInputFolder(dialog.FileName, _settings.Fax.InputFolder);
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("MainWindow.ImportReportFileAndRunAsync", ex);
            MessageBox.Show(
                this,
                $"Couldn't import that file: {ex.Message}",
                "Vaccine Assist",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
            return;
        }

        await _faxRunScheduler.RunNowAsync();
    }

    /// <summary>V-T53: shows FaxRunSummaryWindow plus a tray balloon after
    /// every completed run (scheduled or "Run now") — Will's brief: "tray
    /// balloon 'Vaccine faxes: 12 sent, 1 failed, 2 need a fax number'."</summary>
    private void FaxRunScheduler_OnRunCompleted(object? sender, FaxRunSummary summary)
    {
        _trayIconController?.ShowBalloonTip(
            "Vaccine faxes",
            $"{summary.Sent} sent, {summary.Failed} failed, {summary.NeedsFaxNumber} need a fax number");

        var viewModel = new FaxRunSummaryViewModel(summary, _faxRunOrchestrator, _settings);
        var window = new FaxRunSummaryWindow(viewModel);
        window.Show();
    }

    /// <summary>
    /// Shared by the tray menu's Sign out item — sets _allowRealClose
    /// FIRST so App.xaml.cs's LoggedOut handler (which calls
    /// mainWindow.Close()) isn't intercepted by MainWindow_OnClosing and
    /// redirected back to the tray.
    ///
    /// SECURITY REVIEW FIX (stale embedded session, blocker): clears the
    /// embedded WebView2's own browsing data (cookies/localStorage — see
    /// CloudPageView.ClearBrowsingDataAsync's doc comment) BEFORE raising
    /// LoggedOut, i.e. before App.xaml.cs can show a fresh LoginWindow for
    /// the next pharmacist. Previously only the native/desktop session
    /// (_authService.SignOutAsync/SessionStore.Delete) was cleared —
    /// the cloud page's OWN supabase-js session in that shared profile
    /// would silently survive, so the NEXT sign-in's embedded page could
    /// still show the PREVIOUS pharmacist's account.
    /// </summary>
    private async System.Threading.Tasks.Task SignOutAndRaiseLoggedOutAsync()
    {
        _allowRealClose = true;
        await _cloudPageView.ClearBrowsingDataAsync(TimeSpan.FromSeconds(5));
        await _authService.SignOutAsync();
        LoggedOut?.Invoke(this, EventArgs.Empty);
    }
}
