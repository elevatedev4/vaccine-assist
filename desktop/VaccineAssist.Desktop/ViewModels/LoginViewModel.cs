using System;
using System.Threading.Tasks;
using System.Windows.Input;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Services;
using VaccineAssist.Desktop.Settings;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>
/// Password is intentionally NOT a bound property (binding a PasswordBox's
/// Password is a well-known WPF anti-pattern since it isn't a real
/// DependencyProperty) — Views/LoginWindow.xaml.cs reads it directly from
/// the PasswordBox and passes it into SignInAsync.
/// </summary>
public sealed class LoginViewModel : ObservableObject
{
    private readonly IAuthService _authService;
    private readonly ILocalSettingsService _localSettingsService;
    private readonly IAutoLoginConfigService _autoLoginConfigService;
    private readonly AppSettings _settings;
    private readonly bool _allowAutoLogin;

    private string _email;
    private bool _isBusy;
    private string? _errorMessage;

    /// <param name="allowAutoLogin">
    /// Gate on whether TryAutoSignInAsync is allowed to do anything at all
    /// for this Login screen instance. App.xaml.cs passes true for the
    /// initial startup screen, but false for the screen shown right after
    /// Sign out (MainWindow.LoggedOut -> ShowLoginWindow) — without this,
    /// a workstation with autologin.json seeded would silently and
    /// immediately re-authenticate with the same shared credentials the
    /// instant Sign out finishes, making the button a no-op. Sign-out
    /// always means "show the manual form," never "try the seeded
    /// credentials again."
    /// </param>
    public LoginViewModel(
        IAuthService authService,
        ILocalSettingsService localSettingsService,
        AppSettings settings,
        IAutoLoginConfigService autoLoginConfigService,
        bool allowAutoLogin)
    {
        _authService = authService;
        _localSettingsService = localSettingsService;
        _autoLoginConfigService = autoLoginConfigService;
        _settings = settings;
        _allowAutoLogin = allowAutoLogin;
        _email = settings.LastSignedInEmail ?? "";

        SignInCommand = new AsyncRelayCommand(() => SignInAsync(Email.Trim(), PendingPassword ?? ""), () => !IsBusy);
    }

    /// <summary>Set by the view's code-behind immediately before invoking
    /// SignInCommand (see Views/LoginWindow.xaml.cs) — a stopgap for not
    /// binding PasswordBox.Password directly.</summary>
    public string? PendingPassword { get; set; }

    public string Email
    {
        get => _email;
        set => SetProperty(ref _email, value);
    }

    public bool IsBusy
    {
        get => _isBusy;
        private set => SetProperty(ref _isBusy, value);
    }

    public string? ErrorMessage
    {
        get => _errorMessage;
        private set => SetProperty(ref _errorMessage, value);
    }

    public ICommand SignInCommand { get; }

    /// <summary>Raised once SignInAsync succeeds — MainWindow's composition
    /// (App.xaml.cs) subscribes to this to swap the Login window for the shell.</summary>
    public event EventHandler? SignedIn;

    private async Task SignInAsync(string email, string password)
    {
        if (string.IsNullOrWhiteSpace(email) || string.IsNullOrWhiteSpace(password))
        {
            ErrorMessage = "Enter both the shared email and password.";
            return;
        }

        IsBusy = true;
        ErrorMessage = null;
        try
        {
            var result = await _authService.SignInAsync(email.Trim(), password);
            if (!result.Success)
            {
                ErrorMessage = result.ErrorMessage ?? "Sign-in failed.";
                return;
            }

            Email = email.Trim();
            _settings.LastSignedInEmail = Email;
            _localSettingsService.Save(_settings);

            SignedIn?.Invoke(this, EventArgs.Empty);
        }
        finally
        {
            IsBusy = false;
        }
    }

    /// <summary>
    /// Attempts one silent sign-in using the per-machine config seeded by
    /// bootstrap-fresh.ps1 (see Settings/AutoLoginConfigService.cs), if any
    /// exists. Called once by App.xaml.cs right after the Login window is
    /// shown. No prompts either way:
    ///   - allowAutoLogin was false at construction (the post-Sign-out
    ///     screen) → returns immediately without even reading
    ///     autologin.json. Sign out must actually sign out.
    ///   - No config seeded (AutoLoginDecision says no) → returns
    ///     immediately, the window just shows the normal manual form.
    ///   - Config seeded and sign-in succeeds → SignedIn fires exactly like
    ///     a manual sign-in would, and App.xaml.cs swaps in the main window.
    ///   - Config seeded but sign-in fails (e.g. a stale/bad password) →
    ///     SignInAsync already left ErrorMessage set and IsBusy false, so
    ///     the window is left showing the manual form with that error. This
    ///     method is only ever invoked once per app launch (never on a
    ///     timer/retry), so a bad seeded password can't turn into a
    ///     crash/retry loop — the user just signs in by hand instead.
    /// </summary>
    public async Task TryAutoSignInAsync()
    {
        if (!_allowAutoLogin)
        {
            return;
        }

        var config = _autoLoginConfigService.Load();
        if (!AutoLoginDecision.ShouldAttemptAutoLogin(config))
        {
            return;
        }

        await SignInAsync(config!.Email, config.Password);
    }
}
