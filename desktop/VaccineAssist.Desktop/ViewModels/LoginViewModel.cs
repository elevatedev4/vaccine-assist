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
    private readonly AppSettings _settings;

    private string _email;
    private bool _isBusy;
    private string? _errorMessage;

    public LoginViewModel(IAuthService authService, ILocalSettingsService localSettingsService, AppSettings settings)
    {
        _authService = authService;
        _localSettingsService = localSettingsService;
        _settings = settings;
        _email = settings.LastSignedInEmail ?? "";

        SignInCommand = new AsyncRelayCommand(() => SignInAsync(PendingPassword ?? ""), () => !IsBusy);
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

    private async Task SignInAsync(string password)
    {
        if (string.IsNullOrWhiteSpace(Email) || string.IsNullOrWhiteSpace(password))
        {
            ErrorMessage = "Enter both the shared email and password.";
            return;
        }

        IsBusy = true;
        ErrorMessage = null;
        try
        {
            var result = await _authService.SignInAsync(Email.Trim(), password);
            if (!result.Success)
            {
                ErrorMessage = result.ErrorMessage ?? "Sign-in failed.";
                return;
            }

            _settings.LastSignedInEmail = Email.Trim();
            _localSettingsService.Save(_settings);

            SignedIn?.Invoke(this, EventArgs.Empty);
        }
        finally
        {
            IsBusy = false;
        }
    }
}
