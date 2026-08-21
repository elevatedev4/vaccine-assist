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

        _localSettingsService = new LocalSettingsService();
        _autoLoginConfigService = new AutoLoginConfigService();
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
        _pioneerEntrySequence = new PlaceholderVaccineEntrySequence();

        ShowLoginWindow(attemptAutoLogin: true);
    }

    /// <summary>
    /// Shows a fresh LoginWindow. A local `signedIn` flag (not a shared
    /// field) tracks whether THIS window's Closed event should shut the
    /// app down — closing a login window without signing in means quit;
    /// closing it because sign-in just succeeded (see below) does not.
    ///
    /// <paramref name="attemptAutoLogin"/> is passed straight through to
    /// LoginViewModel's allowAutoLogin constructor parameter: true for the
    /// initial app-startup call (OnStartup, above), false for the call
    /// from ShowMainWindow's Sign-out handler below. Without that
    /// distinction, a workstation with autologin.json seeded would
    /// silently re-authenticate the instant Sign out finished, making the
    /// button a no-op — Sign-out must always land on the manual form, not
    /// retry the same shared credentials.
    ///
    /// When auto-login is allowed, immediately after showing the window
    /// this kicks off one silent auto-login attempt (fire-and-forget —
    /// see LoginViewModel.TryAutoSignInAsync) if bootstrap-fresh.ps1
    /// seeded a per-machine auto-login config. No interactive prompt is
    /// involved either way: on success the SignedIn handler above swaps
    /// in the main window before the user would ordinarily have finished
    /// reading the screen; on failure the same window is simply left
    /// showing the normal manual form with the error, never retried
    /// automatically.
    /// </summary>
    private void ShowLoginWindow(bool attemptAutoLogin)
    {
        var loginViewModel = new LoginViewModel(_authService, _localSettingsService, _settings, _autoLoginConfigService, attemptAutoLogin);
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
        var lotsViewModel = new LotsViewModel(_vaccineApiService);
        // Backs the Active vaccines tab — see MainWindow.xaml.cs's
        // constructor comment and VaccinesViewModel's doc comment.
        var vaccinesViewModel = new VaccinesViewModel(_vaccineApiService);

        var mainWindow = new MainWindow(
            lotsViewModel, vaccinesViewModel, _authService,
            _vaccineApiService, _clipboardService, _pioneerEntrySequence);
        var loggingOut = false;

        mainWindow.LoggedOut += (_, _) =>
        {
            loggingOut = true;
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
