using System;
using System.Net.Http;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;
using VaccineAssist.Desktop.Logging;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.Services;
using VaccineAssist.Desktop.Settings;
using VaccineAssist.Desktop.ViewModels;
using VaccineAssist.Desktop.Views;

namespace VaccineAssist.Desktop;

/// <summary>
/// Composition root — plain manual wiring (DI-light: no container, no
/// service-locator library), matching this app's overall style. Every
/// service is constructed exactly once here and handed to whichever
/// ViewModel needs it.
/// </summary>
public partial class App : Application
{
    private ILocalSettingsService _localSettingsService = null!;
    private IAutoLoginConfigService _autoLoginConfigService = null!;
    private ISessionStore _sessionStore = null!;
    private AppSettings _settings = null!;
    private HttpClient _httpClient = null!;
    private IAuthService _authService = null!;
    private IVaccineApiService _vaccineApiService = null!;
    private IClipboardService _clipboardService = null!;
    private IPioneerEntryAutomation _pioneerEntryAutomation = null!;
    private IPioneerEntrySequence _pioneerEntrySequence = null!;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // CRASH FIX (Will, 2026-08-19/20: "Clicking lots make it crash" /
        // "App crashes when I try to look at several tabs"). Root causes
        // found in the ViewModels/commands themselves are fixed at their
        // source (see AsyncRelayCommand.Execute's new catch clause and
        // LoginViewModel.SignInAsync's new catch around the settings
        // save) — those give the nicer per-tab inline ErrorMessage UX.
        // These three handlers are the last-resort backstop for anything
        // that still isn't caught somewhere more specific: instead of the
        // .NET default (silently terminate the process with no trace),
        // log what happened to %AppData%\VaccineAssist\logs\app.log and
        // tell the user, then keep the app running wherever that's
        // actually possible.
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += OnAppDomainUnhandledException;
        TaskScheduler.UnobservedTaskException += OnUnobservedTaskException;

        // V-T28 item 3 (Will's brief): "the desktop log must name the log
        // file's full path at startup ... so Will can find them" — the
        // very first line ever written to a fresh log file is now that
        // file's own path (UiaTreeDumper.DumpWindowToFile already logs the
        // UIA-dump path whenever one is written — see that method — so
        // between the two, both paths this brief asked for are always
        // discoverable from "Copy logs").
        AppFileLog.Log($"[Startup] Log file: {AppFileLog.LogFilePath}");

        _localSettingsService = new LocalSettingsService();
        _autoLoginConfigService = new AutoLoginConfigService();
        _sessionStore = new SessionStore();
        _settings = _localSettingsService.Load();

        _httpClient = new HttpClient();
        if (!string.IsNullOrWhiteSpace(_settings.CloudApiBaseUrl) &&
            Uri.TryCreate(_settings.CloudApiBaseUrl, UriKind.Absolute, out var cloudApiBaseUri))
        {
            _httpClient.BaseAddress = cloudApiBaseUri;
        }
        // If CloudApiBaseUrl is blank/invalid (expected on a fresh phase-1
        // checkout with no real cloud deployment configured yet),
        // BaseAddress stays null — API calls will fail with a clear
        // UriFormatException that ViewModels surface as ErrorMessage,
        // rather than silently hitting the wrong host.

        _authService = new SupabaseAuthService(_settings);
        _vaccineApiService = new VaccineApiService(_httpClient, _authService);
        _clipboardService = new ClipboardService();
        // Kept constructed (harmless, side-effect-free) even though nothing
        // currently consumes it — it backed the old full-form EntryView,
        // which was repurposed 2026-08-19 into a lightweight hotkey
        // status tab that doesn't need it. Left in place rather than
        // removed in case a future screen needs the IPioneerEntryAutomation
        // abstraction again.
        _pioneerEntryAutomation = new PioneerEntryAutomationStub();
        // V-T3: the ONE sequence implementation shipped in phase 1 — see
        // PioneerEntryAutomation/Sequencing/PlaceholderVaccineEntrySequence.cs.
        // Swapping in the real sequence once vaccine-add-new.mxe is available
        // is a one-line change here, not a rebuild of MainWindow/DataEntryPopupViewModel.
        // _settings.PriorityValue (2026-09-13 priority-popup fix) is threaded
        // through here so a workstation can change it via settings.json with
        // no rebuild — see SendF3AndDismissPreEntryDialogsStep's own doc comment.
        _pioneerEntrySequence = new PlaceholderVaccineEntrySequence(_settings.PriorityValue);

        _ = StartSignInFlowAsync();
    }

    /// <summary>
    /// Startup sign-in orchestration (Will, 2026-09-13 — "The login screen
    /// is still showing momentarily and then disappearing without me
    /// needing to do anything ... don't let it flash the way it is now."
    /// / "If a user already has a login on the computer, don't show the
    /// login screen at all"). Replaces the old
    /// "Show LoginWindow immediately, then try auto-login in the
    /// background" flow (which is exactly what caused the flash) with:
    ///   1. Build the LoginViewModel but do NOT show it yet.
    ///   2. If there's a stored credential worth trying at all
    ///      (LoginViewModel.HasStoredCredential — a not-yet-90-day-expired
    ///      session.json, or a seeded autologin.json), show a tiny
    ///      borderless "Signing in…" splash instead and await the full
    ///      silent attempt (TrySilentSignInAsync: session-restore, then
    ///      autologin.json) before deciding what to do next.
    ///   3. If that succeeded, go straight to MainWindow — the Login
    ///      window is never shown at all, so it can't flash.
    ///   4. If nothing was stored, or the silent attempt failed, show the
    ///      (already-constructed, so any ErrorMessage from the failed
    ///      attempt carries over) LoginViewModel's window now.
    /// </summary>
    private async Task StartSignInFlowAsync()
    {
        var loginViewModel = new LoginViewModel(_authService, _localSettingsService, _settings, _autoLoginConfigService, _sessionStore, allowAutoLogin: true);

        SplashWindow? splash = null;
        if (loginViewModel.HasStoredCredential())
        {
            splash = new SplashWindow();
            MainWindow = splash;
            splash.Show();

            await loginViewModel.TrySilentSignInAsync();
        }

        if (_authService.IsSignedIn)
        {
            ShowMainWindow();
            splash?.Close();
            return;
        }

        splash?.Close();
        ShowLoginWindowWithViewModel(loginViewModel);
    }

    /// <summary>
    /// Shows a LoginWindow for an ALREADY-CONSTRUCTED LoginViewModel —
    /// used both by StartSignInFlowAsync above (the silent attempt, if
    /// any, already ran; showing this window is the fallback) and
    /// implicitly covers "nothing was stored at all," where
    /// TrySilentSignInAsync was never even called. A local `signedIn`
    /// flag (not a shared field) tracks whether THIS window's Closed
    /// event should shut the app down — closing a login window without
    /// signing in means quit; closing it because sign-in just succeeded
    /// (see below) does not.
    /// </summary>
    private void ShowLoginWindowWithViewModel(LoginViewModel loginViewModel)
    {
        var loginWindow = new LoginWindow(loginViewModel);
        var signedIn = false;

        loginViewModel.SignedIn += (_, _) =>
        {
            signedIn = true;
            ShowMainWindow();
            loginWindow.Close();
        };

        loginWindow.Closed += (_, _) =>
        {
            if (!signedIn)
            {
                Shutdown();
            }
        };

        MainWindow = loginWindow;
        loginWindow.Show();
    }

    /// <summary>
    /// Shows a fresh LoginWindow with a brand-new LoginViewModel — used
    /// ONLY by ShowMainWindow's Sign-out handler below.
    /// <paramref name="attemptAutoLogin"/> is passed straight through to
    /// LoginViewModel's allowAutoLogin constructor parameter; it is
    /// always false here. Without that, a workstation with autologin.json
    /// (or the 90-day session.json — deleted on sign-out anyway, see
    /// below, but autologin.json is untouched by sign-out) seeded would
    /// silently re-authenticate the instant Sign out finished, making the
    /// button a no-op — Sign-out must always land on the manual form, not
    /// retry the same shared credentials.
    /// </summary>
    private void ShowLoginWindow(bool attemptAutoLogin)
    {
        var loginViewModel = new LoginViewModel(_authService, _localSettingsService, _settings, _autoLoginConfigService, _sessionStore, attemptAutoLogin);
        var loginWindow = new LoginWindow(loginViewModel);
        var signedIn = false;

        loginViewModel.SignedIn += (_, _) =>
        {
            signedIn = true;
            ShowMainWindow();
            loginWindow.Close();
        };

        loginWindow.Closed += (_, _) =>
        {
            if (!signedIn)
            {
                Shutdown();
            }
        };

        MainWindow = loginWindow;
        loginWindow.Show();

        _ = loginViewModel.TryAutoSignInAsync();
    }

    /// <summary>
    /// Shows the post-login shell. Same local-flag pattern as
    /// ShowLoginWindow: closing MainWindow via Sign out (which
    /// immediately opens a new LoginWindow) must not also shut the app
    /// down; closing it via the window chrome/Alt+F4 must.
    /// </summary>
    private void ShowMainWindow()
    {
        // 2026-09-13 cloud-parity change (Will's brief): Scheduling/Lots/
        // Active vaccines/Ordering/Physicians now each host a
        // CloudPageView (WebView2) instead of a native
        // SchedulingViewModel/LotsViewModel/VaccinesViewModel/
        // OrderingViewModel/PhysiciansViewModel-backed view — see
        // MainWindow.xaml.cs's own doc comment. Those ViewModel classes
        // themselves are unchanged and still independently unit-tested
        // (LotsViewModelTests.cs, PhysiciansViewModelTests.cs, etc.);
        // MainWindow simply no longer constructs/consumes them.
        var mainWindow = new MainWindow(
            _authService, _vaccineApiService, _clipboardService,
            _pioneerEntrySequence, _settings.CloudApiBaseUrl);
        var loggingOut = false;

        mainWindow.LoggedOut += (_, _) =>
        {
            loggingOut = true;
            // Will, 2026-09-13: sign out must actually sign out — delete
            // the persisted 90-day session so the next launch doesn't
            // silently restore right back in. (autologin.json, a
            // separate/older per-machine mechanism, is left untouched;
            // ShowLoginWindow's attemptAutoLogin: false below already
            // covers suppressing that one on this screen.)
            _sessionStore.Delete();
            mainWindow.Close();
            // attemptAutoLogin: false — see ShowLoginWindow's doc comment.
            // Sign out must actually sign out, even when autologin.json is
            // seeded on this workstation.
            ShowLoginWindow(attemptAutoLogin: false);
        };

        mainWindow.Closed += (_, _) =>
        {
            if (!loggingOut)
            {
                Shutdown();
            }
        };

        MainWindow = mainWindow;
        mainWindow.Show();
    }

    /// <summary>
    /// The primary crash backstop: any exception raised while WPF's
    /// Dispatcher processes a UI-thread callback (routed events like
    /// Button.Click, async-void continuations posted back to the UI
    /// thread — which is how AsyncRelayCommand.Execute's own exceptions
    /// would surface if its new catch clause were ever bypassed, property
    /// binding/converter errors, etc.) and that isn't already caught
    /// closer to its source lands here instead of the .NET default of
    /// silently killing the process. e.Handled = true keeps the app
    /// running — a wrong/stale screen is recoverable; a dead process
    /// mid-shift is not.
    /// </summary>
    private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        AppFileLog.LogException("DispatcherUnhandledException", e.Exception);

        MessageBox.Show(
            "Vaccine Assist ran into a problem and had to recover from it. " +
            "The details were saved to a log file (%AppData%\\VaccineAssist\\logs\\app.log) — " +
            "use the Data entry popup's \"Copy logs\" button to grab recent lines if this keeps happening.\n\n" +
            $"{e.Exception.GetType().Name}: {e.Exception.Message}",
            "Vaccine Assist",
            MessageBoxButton.OK,
            MessageBoxImage.Warning);

        e.Handled = true;
    }

    /// <summary>
    /// Backstop for exceptions on a thread other than the UI thread (e.g.
    /// raw ThreadPool work not marshaled back through the Dispatcher).
    /// The CLR does not allow this to be "handled" — if IsTerminating is
    /// true the process is going down regardless — but logging it first
    /// means a crash of this kind still leaves a trace instead of nothing
    /// at all.
    /// </summary>
    private void OnAppDomainUnhandledException(object sender, UnhandledExceptionEventArgs e)
    {
        if (e.ExceptionObject is Exception ex)
        {
            AppFileLog.LogException("AppDomainUnhandledException" + (e.IsTerminating ? " (terminating)" : ""), ex);
        }
        else
        {
            AppFileLog.Log($"[AppDomainUnhandledException] non-Exception payload: {e.ExceptionObject}");
        }
    }

    /// <summary>
    /// Backstop for a faulted Task that nobody ever awaited or observed —
    /// e.g. ShowLoginWindow's `_ = loginViewModel.TryAutoSignInAsync();`
    /// fire-and-forget call. Modern .NET no longer crashes the process
    /// for this by default (unlike .NET Framework), so this handler is
    /// purely for visibility: without it, a fault here would just vanish
    /// silently once the GC collected the Task.
    /// </summary>
    private void OnUnobservedTaskException(object? sender, UnobservedTaskExceptionEventArgs e)
    {
        AppFileLog.LogException("UnobservedTaskException", e.Exception);
        e.SetObserved();
    }
}
