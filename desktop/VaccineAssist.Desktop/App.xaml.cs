using System;
using System.Net.Http;
using System.Windows;
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
        var vaccinesViewModel = new VaccinesViewModel(_vaccineApiService);
        var lotsViewModel = new LotsViewModel(_vaccineApiService);
        var entryViewModel = new EntryViewModel(_vaccineApiService, _clipboardService, _pioneerEntryAutomation);

        var mainWindow = new MainWindow(
            vaccinesViewModel, lotsViewModel, entryViewModel, _authService,
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
}
