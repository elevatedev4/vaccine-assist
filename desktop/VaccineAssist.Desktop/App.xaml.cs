using System;
using System.Net.Http;
using System.Windows;
using VaccineAssist.Desktop.PioneerEntryAutomation;
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
    private AppSettings _settings = null!;
    private HttpClient _httpClient = null!;
    private IAuthService _authService = null!;
    private IVaccineApiService _vaccineApiService = null!;
    private IClipboardService _clipboardService = null!;
    private IPioneerEntryAutomation _pioneerEntryAutomation = null!;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        _localSettingsService = new LocalSettingsService();
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

        ShowLoginWindow();
    }

    /// <summary>
    /// Shows a fresh LoginWindow. A local `signedIn` flag (not a shared
    /// field) tracks whether THIS window's Closed event should shut the
    /// app down — closing a login window without signing in means quit;
    /// closing it because sign-in just succeeded (see below) does not.
    /// </summary>
    private void ShowLoginWindow()
    {
        var loginViewModel = new LoginViewModel(_authService, _localSettingsService, _settings);
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

        var mainWindow = new MainWindow(vaccinesViewModel, lotsViewModel, entryViewModel, _authService);
        var loggingOut = false;

        mainWindow.LoggedOut += (_, _) =>
        {
            loggingOut = true;
            mainWindow.Close();
            ShowLoginWindow();
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
