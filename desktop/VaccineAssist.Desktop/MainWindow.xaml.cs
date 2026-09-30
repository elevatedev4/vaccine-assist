using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Fax;
using VaccineAssist.Desktop.Hotkeys;
using VaccineAssist.Desktop.Logging;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.Overlay;
using VaccineAssist.Desktop.PioneerEntryAutomation;
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
    private readonly HttpClient _faxHttpClient;

    /// <summary>V-T65 R5: the singleton send-queue/live-status/history
    /// service — see Services/FaxSendCoordinator's own doc comment. Every
    /// FaxSendViewModel ShowFaxSendWindow builds wraps this SAME instance,
    /// so state survives the window being closed and reopened.</summary>
    private readonly FaxSendCoordinator _faxSendCoordinator;

    /// <summary>At most one Fax settings window at a time — same
    /// re-activate-not-stack rule as _openMacroCodesPopup.</summary>
    private FaxSettingsWindow? _openFaxSettingsWindow;

    /// <summary>At most one Send PCP faxes window at a time (V-T65 R4) —
    /// same re-activate-not-stack rule as _openFaxSettingsWindow.</summary>
    private FaxSendWindow? _openFaxSendWindow;

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
    /// The currently-open macro-codes popup, if any — same "at most one at
    /// a time, re-activate rather than stack" rule every popup in this
    /// class follows (see ShowMacroCodesPopup), and same reason MainWindow
    /// needs to explicitly close it on sign-out/window-close
    /// (MainWindow_OnClosed): it's not an owned window, so nothing else
    /// would clean it up.
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

    /// <summary>
    /// V-T41 R5 (Will, 2026-09-29 8:15pm brief, item 3): the Ctrl+Keypad 7
    /// hotkey no longer opens DataEntryPopupWindow at all — it now mirrors
    /// the Ctrl+Keypad 2 flow (age prompt, then the same age-filtered
    /// macro-codes picker) and runs this app's own PioneerEntryAutomation
    /// against whatever product is picked, instead of the Ctrl+Keypad 2
    /// flow's synthetic Ctrl+NumPad5 keypress. Tracked separately from
    /// _openAgeMacroPopup (same "at most one instance, re-activate rather
    /// than stack" rule, but a distinct field so the two flows' hotkeys
    /// can never interfere with each other's single-instance bookkeeping).
    /// </summary>
    private MacroCodesWindow? _openVaccineEntryMacroPopup;

    /// <summary>Same re-entrancy guard as _ageMacroPromptShowing, for the
    /// Ctrl+Keypad 7 flow's own AgePromptWindow.ShowAndGetResult call.</summary>
    private bool _vaccineEntryAgePromptShowing;

    /// <summary>
    /// Non-null for the whole life of an active Ctrl+Keypad 7
    /// PioneerEntryAutomation run — the entry-status overlay's X button
    /// (PioneerOverlayController.EntryStatusCancelRequested -&gt;
    /// CancelVaccineEntryRun) cancels THIS token. Null whenever no run is
    /// in flight (also used as the "is a run currently active" guard by
    /// ShowDataEntryPopup, so a repeat Ctrl+Keypad 7 press mid-run doesn't
    /// start a second overlapping one).
    /// </summary>
    private CancellationTokenSource? _vaccineEntryCts;

    /// <summary>The most recent step name LogVaccineEntryStep parsed out of
    /// a "[StepName] ..." log line for the run _vaccineEntryCts is tracking
    /// — used only to name the step in the "Halted by user at step ..." log
    /// line when cancellation is observed BETWEEN steps (PioneerEntrySequenceRunner's
    /// own cancellationToken.ThrowIfCancellationRequested() check, which
    /// throws out of RunAsync entirely rather than returning a normal
    /// per-step failure).</summary>
    private string? _vaccineEntryCurrentStepName;

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
        HttpClient faxHttpClient,
        FaxSendCoordinator faxSendCoordinator)
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
        _faxHttpClient = faxHttpClient;
        _faxSendCoordinator = faxSendCoordinator;

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
            trayIconController.FaxSettingsRequested += (_, _) => ShowFaxSettings();
            trayIconController.FaxOpenFolderRequested += (_, _) => OpenFaxFolder();
            trayIconController.FaxImportFileRequested += (_, _) => ShowFaxSendWindow();
            // V-T65 R5 (Will, verbatim: "allow the app to work from the
            // background to send faxes ... make sure the status is
            // displayed correctly") — tray tooltip reflects the
            // coordinator's live in-process count regardless of whether
            // FaxSendWindow is open; seeded once here in case a run was
            // already in flight the moment this MainWindow was built
            // (a fresh sign-in with a previous session's faxes still
            // resolving would otherwise show nothing until the next tick).
            _faxSendCoordinator.InProcessCountChanged += (_, _) =>
                trayIconController.UpdateFaxTooltip(_faxSendCoordinator.InProcessCount);
            trayIconController.UpdateFaxTooltip(_faxSendCoordinator.InProcessCount);
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
            var pioneerOverlayController = new PioneerOverlayController(
                navigateTo: NavigateTo,
                showDataEntryPopup: ShowDataEntryPopup,
                showMacroCodesPopup: ShowMacroCodesPopup,
                exit: ExitApplication,
                settings: _settings);
            // V-T41 R5 (item 4): the entry-status panel's X button.
            pioneerOverlayController.EntryStatusCancelRequested += (_, _) => CancelVaccineEntryRun();
            _pioneerOverlayController = pioneerOverlayController;
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

        _openFaxSendWindow?.Close();
        _openFaxSendWindow = null;

        // Covers both exit paths: MainWindow closing directly (chrome/
        // Alt+F4, or the tray's Exit — both only reach here now via
        // _allowRealClose) and Sign out (LogoutButton_OnClick/tray Sign
        // out -> App.xaml.cs's LoggedOut handler calls mainWindow.Close(),
        // which raises this same Closed event) — see _openMacroCodesPopup's
        // doc comment for why an orphaned popup is a real problem, not
        // just cosmetic.
        _openMacroCodesPopup?.Close();
        _openMacroCodesPopup = null;

        _openAgeMacroPopup?.Close();
        _openAgeMacroPopup = null;

        // V-T41 R5: cancel any in-flight Ctrl+Keypad 7 automation and close
        // its macro-codes picker if still open, same "an orphaned popup/run
        // must not survive sign-out or window-close" reasoning as the other
        // popups above.
        CancelVaccineEntryRun();

        _openVaccineEntryMacroPopup?.Close();
        _openVaccineEntryMacroPopup = null;
    }

    /// <summary>
    /// V-T41 R5 (Will, 2026-09-29 8:15pm brief, item 3, verbatim): "let's
    /// make the flow match the Ctrl+Keypad 2 flow we have right now, with
    /// an age window, then the macro codes, then the window disappears."
    /// Ctrl+Keypad 7 no longer opens DataEntryPopupWindow at all (BYPASSED,
    /// not deleted — the class/its tests are left in place in case a future
    /// round needs the guided-flow UI again, but nothing live constructs it
    /// any more); this method — still the one thing the hotkey, the tray
    /// menu's "Data entry" item, and the Pioneer overlay's "Data entry"
    /// item all call — now runs ShowVaccineEntryAgeMacroPrompt instead: age
    /// prompt, then the SAME age-filtered macro-codes picker the Ctrl+
    /// Keypad 2 flow uses, then this app's own PioneerEntryAutomation runs
    /// against whatever product was picked (see RunVaccineEntryAutomationAsync)
    /// instead of that flow's synthetic Ctrl+NumPad5 keypress.
    ///
    /// A repeat press while a run is already in flight (_vaccineEntryCts is
    /// non-null) is a no-op — the overlay's X is the way to stop it, not a
    /// second hotkey press starting a second, overlapping run. A repeat
    /// press while the macro-codes picker is already open re-activates that
    /// SAME instance (same "at most one instance" rule every other popup in
    /// this class follows) instead of stacking a second age prompt on top.
    /// </summary>
    private void ShowDataEntryPopup()
    {
        if (_vaccineEntryCts is not null)
        {
            return;
        }

        if (_openVaccineEntryMacroPopup is not null)
        {
            _openVaccineEntryMacroPopup.BringToFront();
            return;
        }

        if (_vaccineEntryAgePromptShowing)
        {
            return;
        }

        ShowVaccineEntryAgeMacroPrompt();
    }

    /// <summary>
    /// V-T41 R5, item 3: age prompt -&gt; age-filtered macro-codes picker
    /// (identical URL-building to ShowAgeMacroPrompt's own
    /// AgeMacroCodesUrlBuilder.BuildUrl call) -&gt; once a dose is picked and
    /// the picker closes, RunVaccineEntryAutomationAsync runs this app's
    /// PioneerEntryAutomation against it. sendCtrlNumPad5OnClose is
    /// deliberately false here (unlike ShowAgeMacroPrompt) — that synthetic
    /// keypress exists only to trigger the EXTERNAL on-computer macro the
    /// Ctrl+Keypad 2 flow hands off to (see MacroCodesWindow's own doc
    /// comment); this flow runs its own automation instead and must never
    /// also fire that macro.
    ///
    /// Automation is kicked off from the popup's OWN Closed handler (not
    /// from onCodeCopied directly) so it only starts once MacroCodesWindow_OnClosed's
    /// SetForegroundWindow(previousForegroundWindow) has already run —
    /// same ordering ShowAgeMacroPrompt's synthetic-keypress path relies on
    /// (see MacroCodesWindow_OnClosed's own doc comment on why that delay
    /// matters).
    /// </summary>
    private void ShowVaccineEntryAgeMacroPrompt()
    {
        AppFileLog.Log("[VaccineEntry] age prompt");

        var previousForegroundWindow = GetForegroundWindow();
        AgePromptResult result;
        _vaccineEntryAgePromptShowing = true;
        try
        {
            result = AgePromptWindow.ShowAndGetResult();
        }
        finally
        {
            _vaccineEntryAgePromptShowing = false;
        }

        if (!result.Confirmed)
        {
            AppFileLog.Log("[VaccineEntry] age prompt cancelled");
            return;
        }

        var ageYears = result.Years;
        AppFileLog.Log($"[VaccineEntry] age {ageYears}");

        string? pickedCode = null;
        string? pickedLabel = null;
        string? pickedProduct = null;

        var url = AgeMacroCodesUrlBuilder.BuildUrl(_settings.CloudApiBaseUrl, ageYears);
        var popup = new MacroCodesWindow(
            _settings.CloudApiBaseUrl,
            _clipboardService,
            previousForegroundWindow,
            overrideUrl: url,
            sendCtrlNumPad5OnClose: false,
            onCodeCopied: (code, label, product) =>
            {
                pickedCode = code;
                pickedLabel = label;
                pickedProduct = product;
            });

        popup.Closed += (_, _) =>
        {
            if (ReferenceEquals(_openVaccineEntryMacroPopup, popup))
            {
                _openVaccineEntryMacroPopup = null;
            }

            if (pickedCode is not null)
            {
                _ = RunVaccineEntryAutomationAsync(pickedCode, pickedLabel ?? "", pickedProduct ?? "", ageYears);
            }
            else
            {
                AppFileLog.Log("[VaccineEntry] macro picker closed with nothing picked");
            }
        };
        _openVaccineEntryMacroPopup = popup;

        AppFileLog.Log("[VaccineEntry] macro picker opened");
        popup.Show();
        popup.ActivateAndFocusWebView();
    }

    /// <summary>
    /// V-T41 R5, items 2-4: runs PlaceholderVaccineEntrySequence against the
    /// vaccine `macroCode` (a MacroCodesWindow onCodeCopied payload) refers
    /// to.
    ///
    /// ITEM 2 (Will: "I also wonder if the vaccine assist data entry window
    /// visually blocking the priority window before has any impact?"): by
    /// construction, AgePromptWindow and the macro-codes picker are ALREADY
    /// closed by the time this runs (the picker's own Closed handler is
    /// what calls this) — the only OTHER activatable Vaccine Assist window
    /// that could still be visible is MainWindow itself, so that's the one
    /// explicit check below, hidden to the tray before the first key is
    /// sent and logged either way.
    ///
    /// ITEM 3: parses the macro text (MacroCodeParser), resolves the real
    /// Vaccine catalog row by short code (MacroCodeVaccineResolver) against
    /// GetVaccinesAsync(), resolves the protocol physician for that vaccine
    /// + age (same IVaccineApiService.ResolvePhysicianAsync
    /// DataEntryPopupViewModel.BuildLivePayloadAsync uses), and builds a
    /// VaccineEntryPayload the SAME shape that method builds — Quantity/
    /// Directions fall back through VaccineEntryDefaults exactly like the
    /// old guided flow did.
    ///
    /// ITEM 4: ShowEntryStatus/UpdateEntryStatusStep/HideEntryStatus drive
    /// the overlay panel; _vaccineEntryCts is what its X button cancels.
    /// </summary>
    private async Task RunVaccineEntryAutomationAsync(string macroCode, string label, string product, int ageYears)
    {
        AppFileLog.Log($"[VaccineEntry] picked \"{product}\" ({label})");

        using var cts = new CancellationTokenSource();
        _vaccineEntryCts = cts;
        _vaccineEntryCurrentStepName = null;
        _pioneerOverlayController?.ShowEntryStatus("Preparing…");

        var hiddenWindows = new List<string>();
        // Same "no tray icon to restore from" guard MainWindow_OnStateChanged/
        // MainWindow_OnClosing already use — hiding MainWindow with no tray
        // icon (rare: only when TrayIconController's own construction threw)
        // would strand the pharmacist with no way to bring it back.
        if (IsVisible && _trayIconController is not null)
        {
            HideToTray();
            hiddenWindows.Add("MainWindow");
        }
        AppFileLog.Log($"[VaccineEntry] windows hidden before automation: {(hiddenWindows.Count > 0 ? string.Join(", ", hiddenWindows) : "none (nothing else visible)")}");

        try
        {
            var parsed = MacroCodeParser.TryParse(macroCode);
            if (parsed is null)
            {
                AppFileLog.Log("[VaccineEntry] FAILED — couldn't parse the picked macro code.");
                return;
            }

            PioneerEntrySequenceResult? result = null;
            try
            {
                // REVIEWER FIX (non-blocking, V-T41 R5): widened to cover
                // GetVaccinesAsync/ResolvePhysicianAsync too, not just the
                // FlaUI sequence itself — a cancel that lands BEFORE
                // PioneerEntrySequenceRunner.RunAsync ever starts (e.g. the
                // overlay's X clicked during the initial vaccine-lookup
                // round trip) now also logs "Halted by user" instead of
                // falling through to the generic catch below and logging a
                // raw exception dump for what was really just a cancel.
                var vaccines = await _vaccineApiService.GetVaccinesAsync(cts.Token);
                var vaccine = MacroCodeVaccineResolver.FindByShortCode(vaccines, parsed.Value.ShortCode);
                if (vaccine is null)
                {
                    AppFileLog.Log($"[VaccineEntry] FAILED — no vaccine on file with short code \"{parsed.Value.ShortCode}\".");
                    return;
                }

                var physician = await _vaccineApiService.ResolvePhysicianAsync(vaccine.Id, ageYears, cts.Token);
                if (physician is null)
                {
                    AppFileLog.Log($"[VaccineEntry] FAILED — no protocol physician configured for {vaccine.Name} at age {ageYears}.");
                    return;
                }

                var quantity = VaccineEntryDefaults.ResolveQuantity(vaccine).Value;
                var directions = VaccineEntryDefaults.ResolveDirections(vaccine).Value;
                var hasLot = !string.IsNullOrWhiteSpace(parsed.Value.LotNumber) && !string.IsNullOrWhiteSpace(parsed.Value.ExpirationMacroFormat);

                var payload = new VaccineEntryPayload(
                    vaccine.ShortCode, parsed.Value.LotNumber, parsed.Value.ExpirationMacroFormat, AdminSiteDisplayText: "",
                    Ndc: vaccine.Ndc ?? "",
                    PhysicianAlternateId: physician.AlternateId,
                    SkipLotAndExpiration: !hasLot,
                    Quantity: quantity,
                    Directions: directions,
                    VaccineName: vaccine.Name);

                var dryRun = !PioneerRxPresence.IsPresent();
                var context = new PioneerEntryStepContext(payload, dryRun, message => LogVaccineEntryStep(message))
                {
                    RequestTextPrompt = (title, message, allowSkip) => TextEntryPromptWindow.ShowAndGetResult(title, message, allowSkip, this),
                    SaveQuantityAsync = q => SaveVaccineEntryFieldAsync(() => _vaccineApiService.UpdateVaccineQuantityAsync(vaccine.Id, q)),
                    SaveDirectionsAsync = d => SaveVaccineEntryFieldAsync(() => _vaccineApiService.UpdateVaccineDirectionsAsync(vaccine.Id, d)),
                };

                result = await PioneerEntrySequenceRunner.RunAsync(_pioneerEntrySequence, context, cts.Token);
            }
            catch (OperationCanceledException)
            {
                AppFileLog.Log($"[VaccineEntry] Halted by user at step {_vaccineEntryCurrentStepName ?? "(unknown)"}.");
                return;
            }

            if (cts.Token.IsCancellationRequested)
            {
                AppFileLog.Log($"[VaccineEntry] Halted by user at step {result?.FirstFailure?.StepName ?? _vaccineEntryCurrentStepName ?? "(unknown)"}.");
            }
            else if (result?.Success == true)
            {
                AppFileLog.Log("[VaccineEntry] completed.");
            }
            else
            {
                AppFileLog.Log($"[VaccineEntry] stopped at \"{result?.FirstFailure?.StepName}\" — {result?.FirstFailure?.Message}");
            }
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("MainWindow.RunVaccineEntryAutomationAsync", ex);
        }
        finally
        {
            _pioneerOverlayController?.HideEntryStatus();
            _vaccineEntryCts = null;
        }
    }

    /// <summary>Parses the leading "[StepName] " prefix every
    /// PioneerEntrySequenceRunner log line carries (see RunOneStepAsync)
    /// so the overlay's step line and a "Halted by user at step ..."
    /// message both name the right step, without RunVaccineEntryAutomationAsync
    /// needing its own separate step-tracking hook into the runner.</summary>
    private void LogVaccineEntryStep(string message)
    {
        AppFileLog.Log($"[VaccineEntry] {message}");

        if (message.Length > 1 && message[0] == '[')
        {
            var close = message.IndexOf(']');
            if (close > 1)
            {
                var stepName = message[1..close];
                _vaccineEntryCurrentStepName = stepName;
                _pioneerOverlayController?.UpdateEntryStatusStep(stepName);
            }
        }
    }

    /// <summary>Same "a failed save must not abort the entry" posture as
    /// DataEntryPopupViewModel.SaveVaccineFieldAsync — see that method's
    /// own doc comment.</summary>
    private static async Task<bool> SaveVaccineEntryFieldAsync(Func<Task<Vaccine>> save)
    {
        try
        {
            await save();
            return true;
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("MainWindow.SaveVaccineEntryFieldAsync", ex);
            return false;
        }
    }

    /// <summary>V-T41 R5, item 4: the entry-status overlay's X button —
    /// PioneerOverlayController.EntryStatusCancelRequested. Best-effort;
    /// cancelling an already-disposed/null token source is harmless.</summary>
    private void CancelVaccineEntryRun()
    {
        try
        {
            _vaccineEntryCts?.Cancel();
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("MainWindow.CancelVaccineEntryRun", ex);
        }
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
        // FOCUS FIX (Will, 2026-09-28): Show() alone doesn't grab keyboard
        // focus away from whatever hotkey-triggered popups launch on top
        // of (typically PioneerRx) — see
        // MacroCodesWindow.ActivateAndFocusWebView's doc comment.
        popup.ActivateAndFocusWebView();
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
        // FOCUS FIX (Will, 2026-09-28, 1:14pm): "the macro-codes popup
        // appears but does NOT have keyboard focus... he needs the popup
        // focused so pressing F immediately picks Flucelvax." The age
        // prompt that just closed (AgePromptWindow.ShowAndGetResult,
        // modal) leaves PioneerRx (captured above as
        // previousForegroundWindow) as the foreground window, so this
        // popup needs the same foreground-stealing sequence
        // DataEntryPopupWindow uses — see
        // MacroCodesWindow.ActivateAndFocusWebView's doc comment.
        popup.ActivateAndFocusWebView();
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

        var viewModel = new FaxSettingsViewModel(_settings, _localSettingsService, _faxCredentialStore, _faxHttpClient);
        // Notifyre-key-visibility follow-up (Will, 2026-09-28): rebuild
        // the orchestrator's live IFaxClient from whatever's now on disk
        // every time Settings persists a credential/provider change — see
        // RebuildFaxClient's own doc comment for the "not done for phase
        // 1" gap this closes.
        viewModel.CredentialsSaved += RebuildFaxClient;
        var window = new FaxSettingsWindow(viewModel);
        window.Closed += (_, _) =>
        {
            viewModel.CredentialsSaved -= RebuildFaxClient;
            if (ReferenceEquals(_openFaxSettingsWindow, window))
            {
                _openFaxSettingsWindow = null;
            }
        };
        _openFaxSettingsWindow = window;
        window.Show();
    }

    /// <summary>Notifyre-key-visibility follow-up (Will, 2026-09-28):
    /// "the real send path ... must read the STORED token, never a
    /// transient textbox value" — App.xaml.cs originally built
    /// _faxRunOrchestrator's IFaxClient ONCE at startup from whatever
    /// credentials were on disk then (see its own "not done for phase 1"
    /// comment), so a token saved mid-session never took effect until a
    /// restart. Re-reads FaxCredentialStore + the current provider right
    /// after Fax settings saves anything, and swaps the orchestrator's
    /// client for a fresh one built from that — same
    /// FaxClientFactory.Create call App.xaml.cs's startup path uses.</summary>
    private void RebuildFaxClient()
    {
        var freshCredentials = _faxCredentialStore.Load() ?? new FaxCredentials();
        var freshClient = FaxClientFactory.Create(_settings.Fax.Provider, _faxHttpClient, freshCredentials);
        _faxRunOrchestrator.UpdateFaxClient(freshClient);
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
    /// V-T65 R4 (Will, verbatim, 2026-09-29): "make the menu be called
    /// 'Vaccines-Send PCP faxes', have that open a dialogue window where
    /// you can selec tht efile then push send then see the results
    /// below." Tray icon -> ONE window (FaxSendWindow) that owns BOTH the
    /// file picker AND the results grid — nothing sends until Will
    /// presses Send inside it (replaces the old immediate-send-on-pick
    /// flow and the separate FaxRunSummaryWindow). Same
    /// re-activate-not-stack rule as ShowFaxSettings.
    /// </summary>
    private void ShowFaxSendWindow()
    {
        if (_openFaxSendWindow is not null)
        {
            _openFaxSendWindow.Activate();
            return;
        }

        // V-T65 R5: wraps the SAME FaxSendCoordinator every time — closing
        // this window never cancels a send or stops polling, and
        // reopening it (this path) re-binds to whatever state the
        // coordinator already has (see FaxSendViewModel's doc comment).
        var viewModel = new FaxSendViewModel(_faxSendCoordinator);
        var window = new FaxSendWindow(viewModel);
        window.Closed += (_, _) =>
        {
            // Reviewer fix (V-T65 R5 REQUEST_CHANGES, 2026-09-29):
            // without this, every open/close cycle left this VM's
            // PropertyChanged subscription rooted in the session-long
            // _faxSendCoordinator forever — see FaxSendViewModel's own
            // doc comment on the leak this closes.
            viewModel.Dispose();
            if (ReferenceEquals(_openFaxSendWindow, window))
            {
                _openFaxSendWindow = null;
            }
        };
        _openFaxSendWindow = window;
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
