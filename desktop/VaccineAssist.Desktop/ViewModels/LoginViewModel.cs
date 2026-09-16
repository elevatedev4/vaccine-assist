using System;
using System.Threading.Tasks;
using System.Windows.Input;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Logging;
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
    /// <summary>
    /// A sign-in attempt (the Supabase network call itself) is capped at
    /// this by default — Will, 2026-09-16 (verbatim): "Add an overall
    /// timeout ... that surfaces 'Couldn't reach the sign-in service.'"
    /// Root-cause note: this alone does not explain "sign in does
    /// nothing" (see SetBusy's doc comment for the actual busy-flag/
    /// handoff bug) — it's the belt-and-suspenders fix for the auth call
    /// itself hanging, so the button can never spin forever no matter
    /// what's wrong on the wire. Overridable per instance (constructor's
    /// signInTimeout parameter) purely for test speed — same pattern as
    /// StartupSignInCoordinator's timeLimit parameter/DefaultTimeLimit.
    /// </summary>
    public static readonly TimeSpan DefaultSignInTimeout = TimeSpan.FromSeconds(20);

    private readonly IAuthService _authService;
    private readonly ILocalSettingsService _localSettingsService;
    private readonly IAutoLoginConfigService _autoLoginConfigService;
    private readonly ISessionStore _sessionStore;
    private readonly AppSettings _settings;
    private readonly bool _allowAutoLogin;
    private readonly TimeSpan _signInTimeout;

    private string _email;
    private bool _isBusy;
    private string? _errorMessage;

    /// <param name="sessionStore">
    /// Backs the 90-day silent sign-in (Will, 2026-09-13) — see
    /// HasStoredCredential/TrySilentSignInAsync. Checked BEFORE
    /// autologin.json (TryAutoSignInAsync) since it reflects the most
    /// recent actual sign-in on this workstation, whichever form that
    /// took.
    /// </param>
    /// <param name="allowAutoLogin">
    /// Gate on whether TryAutoSignInAsync/TrySilentSignInAsync are allowed
    /// to do anything at all for this Login screen instance. App.xaml.cs
    /// passes true for the initial startup screen, but false for the
    /// screen shown right after Sign out (MainWindow.LoggedOut ->
    /// ShowLoginWindow) — without this, a workstation with autologin.json
    /// (or, now, a not-yet-expired session.json) would silently and
    /// immediately re-authenticate with the same credentials the instant
    /// Sign out finishes, making the button a no-op. Sign-out always
    /// means "show the manual form," never "try the stored credentials
    /// again" (and separately deletes session.json — see App.xaml.cs's
    /// LoggedOut handler).
    /// </param>
    public LoginViewModel(
        IAuthService authService,
        ILocalSettingsService localSettingsService,
        AppSettings settings,
        IAutoLoginConfigService autoLoginConfigService,
        ISessionStore sessionStore,
        bool allowAutoLogin,
        TimeSpan? signInTimeout = null)
    {
        _authService = authService;
        _localSettingsService = localSettingsService;
        _autoLoginConfigService = autoLoginConfigService;
        _sessionStore = sessionStore;
        _settings = settings;
        _allowAutoLogin = allowAutoLogin;
        _signInTimeout = signInTimeout ?? DefaultSignInTimeout;
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

    /// <summary>
    /// Lets App.xaml.cs surface a reason on the LoginWindow it's about to
    /// show after a failed/timed-out/cancelled silent sign-in attempt at
    /// startup (see StartSignInFlowAsync/StartupSignInCoordinator) — the
    /// same ErrorMessage the manual form already binds to
    /// (Views/LoginWindow.xaml), just set from the outside instead of by
    /// SignInAsync itself. ErrorMessage's setter stays private otherwise;
    /// this is the one sanctioned external write.
    /// </summary>
    public void SetErrorMessage(string? message) => ErrorMessage = message;

    /// <summary>
    /// Lets App.xaml.cs keep the busy/spinner state alive across the
    /// post-sign-in cloud handoff + MainWindow creation (the SignedIn
    /// event's async handlers in ShowLoginWindowWithViewModel/
    /// ShowLoginWindow). ROOT CAUSE (Will, 2026-09-16: "I just tried to
    /// sign in and it's just not doing anything ... there must be an
    /// error since it's not moving"): SignedIn?.Invoke(...) below starts
    /// those async lambdas synchronously, but only up to their first
    /// await — control then returns here, straight into this method's own
    /// `finally { IsBusy = false; }`. IsBusy was flipping back to false
    /// (spinner gone, button re-enabled) the instant the Supabase call
    /// itself finished, even though the SUBSCRIBER was still doing real
    /// work (WebView2 init + PerformDesktopHandoffAsync, up to ~25s worst
    /// case) before the window actually changes — that gap, nothing
    /// visibly happening while work is still in flight, is exactly what
    /// looked like "doing nothing." App.xaml.cs's SignedIn handlers now
    /// call SetBusy(true) first thing and SetBusy(false) only if that
    /// work fails (success closes the login window instead, so there's
    /// nothing left to un-busy). Same sanctioned-external-write pattern as
    /// SetErrorMessage; IsBusy's setter otherwise stays private.
    /// </summary>
    public void SetBusy(bool busy) => IsBusy = busy;

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
            var signInTask = _authService.SignInAsync(email.Trim(), password);
            var timeoutTask = Task.Delay(_signInTimeout);
            var completed = await Task.WhenAny(signInTask, timeoutTask).ConfigureAwait(false);
            if (completed == timeoutTask)
            {
                AppFileLog.Log($"[SignIn] timed out after {_signInTimeout.TotalSeconds:0}s waiting for the sign-in service");
                ObserveLateCompletion(signInTask);
                ErrorMessage = SignInErrorMapper.NetworkOrTimeoutMessage;
                return;
            }

            var result = await signInTask.ConfigureAwait(false);
            if (!result.Success)
            {
                // Technical detail (raw Supabase/HTTP error text) goes to
                // the log file only — SignInErrorMapper.Map below is what
                // the user actually sees (Will, 2026-09-16: "it's
                // returning errors in an ugly format, needs to be user
                // friendly").
                AppFileLog.Log($"[SignIn] failed: {result.ErrorMessage}");
                ErrorMessage = SignInErrorMapper.Map(result.ErrorMessage);
                return;
            }

            Email = email.Trim();
            _settings.LastSignedInEmail = Email;
            // CRASH FIX (Will, 2026-08-19/20): this write to
            // %AppData%\VaccineAssist\settings.json had no catch around
            // it — a locked file, a permissions issue, or a roaming-
            // profile sync conflict on a real pharmacy workstation would
            // throw an IOException straight out of this async method.
            // Sign-in already succeeded at this point (the cloud session
            // is real), so a failed local "remember the email" write
            // should never block getting into the app: log it, keep
            // going, still raise SignedIn below.
            try
            {
                _localSettingsService.Save(_settings);
            }
            catch (Exception ex)
            {
                AppFileLog.LogException("LoginViewModel.SignInAsync (settings save)", ex);
            }

            // Will, 2026-09-13: "make that last for 90 days without
            // requiring a login again." Every successful call through
            // this method — manual entry OR the seeded autologin.json
            // path (TryAutoSignInAsync calls this same method) — resets
            // the 90-day clock to now. That's deliberate: an
            // autologin.json machine already re-authenticates silently on
            // every single restart regardless, so layering a rolling
            // session.json on top is harmless there and gives a real
            // human's manual sign-in the full 90 days it was promised.
            // Same resilience pattern as the settings save above — a
            // failed write here must never stop sign-in from completing.
            try
            {
                if (_authService.AccessToken is { Length: > 0 } accessToken &&
                    _authService.RefreshToken is { Length: > 0 } refreshToken)
                {
                    _sessionStore.Save(new PersistedSession(accessToken, refreshToken, DateTime.UtcNow));
                }
            }
            catch (Exception ex)
            {
                AppFileLog.LogException("LoginViewModel.SignInAsync (session save)", ex);
            }

            SignedIn?.Invoke(this, EventArgs.Empty);
        }
        catch (Exception ex)
        {
            // Backstop for anything else unexpected in this method (e.g.
            // a SignedIn subscriber throwing) — surfaced the same way
            // every other screen's failed action is (inline ErrorMessage,
            // never a crash), matching LotsViewModel/VaccinesViewModel/
            // SchedulingViewModel/DataEntryPopupViewModel's pattern. Routed
            // through SignInErrorMapper like every other failure path here —
            // ex.Message can be raw/technical (an HttpRequestException's
            // message, a Gotrue exception's message, etc.).
            ErrorMessage = SignInErrorMapper.Map(ex.Message);
            AppFileLog.LogException("LoginViewModel.SignInAsync", ex);
        }
        finally
        {
            IsBusy = false;
        }
    }

    /// <summary>
    /// A sign-in attempt abandoned by SignInAsync's own SignInTimeout race
    /// keeps running in the background (IAuthService takes no
    /// CancellationToken, so there's nothing to actually cancel — same
    /// posture as StartupSignInCoordinator.ObserveLateCompletion, which
    /// this mirrors). This only makes sure its eventual completion or
    /// fault is logged and never becomes an UnobservedTaskException; it
    /// deliberately never touches ErrorMessage/IsBusy/SignedIn again — by
    /// the time this fires, the UI has already shown the timeout message
    /// and moved on.
    /// </summary>
    private static void ObserveLateCompletion(Task<AuthResult> task)
    {
        _ = task.ContinueWith(
            t =>
            {
                if (t.IsFaulted)
                {
                    var ex = t.Exception?.GetBaseException();
                    AppFileLog.Log($"[SignIn] late completion after timeout: faulted ({ex?.GetType().Name}: {ex?.Message})");
                }
                else if (t.IsCompletedSuccessfully)
                {
                    AppFileLog.Log($"[SignIn] late completion after timeout: success={t.Result.Success}");
                }
            },
            TaskScheduler.Default);
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

        // Never log the email/password themselves (config.Email/Password) —
        // only the outcome and, on failure, the (already-generic)
        // ErrorMessage SignInAsync left behind.
        AppFileLog.Log(_authService.IsSignedIn
            ? "[Startup] autologin: ok"
            : $"[Startup] autologin: failed ({ErrorMessage ?? "unknown reason"})");
    }

    /// <summary>
    /// True when there's SOME stored credential worth attempting silently
    /// at startup — either a not-yet-90-day-expired session.json or a
    /// seeded autologin.json. App.xaml.cs's StartSignInFlowAsync calls
    /// this BEFORE showing anything, to decide whether to show a brief
    /// "Signing in…" splash and attempt TrySilentSignInAsync, or go
    /// straight to the manual Login window exactly as before (Will,
    /// 2026-09-13: "If a user already has a login on the computer, don't
    /// show the login screen at all… don't let it flash the way it is
    /// now" / "If nothing is stored, show LoginWindow as today"). Read-
    /// only — never mutates anything, and (like everything else here)
    /// tolerant of a corrupt/undecryptable session.json.
    /// </summary>
    public bool HasStoredCredential()
    {
        if (!_allowAutoLogin)
        {
            return false;
        }

        PersistedSession? persisted;
        try
        {
            persisted = _sessionStore.Load();
        }
        catch
        {
            persisted = null;
        }

        if (persisted is not null && SessionExpiry.IsValid(persisted.IssuedAtUtc, DateTime.UtcNow))
        {
            return true;
        }

        return AutoLoginDecision.ShouldAttemptAutoLogin(_autoLoginConfigService.Load());
    }

    /// <summary>
    /// Combined silent sign-in for app startup: tries the persisted
    /// 90-day session first, and only if that doesn't apply/fails falls
    /// back to the existing seeded-autologin.json path
    /// (TryAutoSignInAsync). Deliberately does NOT surface an
    /// ErrorMessage when the session-restore step itself fails or simply
    /// doesn't apply (an expired/revoked persisted session isn't a
    /// mistake the user made — the manual form should just come up
    /// blank); TryAutoSignInAsync's own existing ErrorMessage behavior on
    /// a bad seeded password is unchanged.
    /// </summary>
    public async Task TrySilentSignInAsync()
    {
        if (!_allowAutoLogin)
        {
            return;
        }

        if (await TryRestoreSessionAsync())
        {
            return;
        }

        await TryAutoSignInAsync();
    }

    private async Task<bool> TryRestoreSessionAsync()
    {
        PersistedSession? persisted;
        try
        {
            persisted = _sessionStore.Load();
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("LoginViewModel.TryRestoreSessionAsync (session load)", ex);
            AppFileLog.Log($"[Startup] session restore: failed (could not read stored session: {ex.GetType().Name})");
            return false;
        }

        if (persisted is null || !SessionExpiry.IsValid(persisted.IssuedAtUtc, DateTime.UtcNow))
        {
            AppFileLog.Log("[Startup] session restore: failed (no valid stored session)");
            return false;
        }

        IsBusy = true;
        try
        {
            var result = await _authService.TryRestoreSessionAsync(persisted.AccessToken, persisted.RefreshToken);
            if (!result.Success)
            {
                AppFileLog.Log($"[Startup] session restore: failed ({result.ErrorMessage ?? "rejected"})");
                return false;
            }

            // Re-persist the (likely rotated) tokens but keep the
            // ORIGINAL IssuedAtUtc — the 90-day window tracks the last
            // time a human actually signed in, not each silent restore.
            try
            {
                if (_authService.AccessToken is { Length: > 0 } accessToken &&
                    _authService.RefreshToken is { Length: > 0 } refreshToken)
                {
                    _sessionStore.Save(new PersistedSession(accessToken, refreshToken, persisted.IssuedAtUtc));
                }
            }
            catch (Exception ex)
            {
                AppFileLog.LogException("LoginViewModel.TryRestoreSessionAsync (session save)", ex);
            }

            AppFileLog.Log("[Startup] session restore: ok");
            SignedIn?.Invoke(this, EventArgs.Empty);
            return true;
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("LoginViewModel.TryRestoreSessionAsync", ex);
            AppFileLog.Log($"[Startup] session restore: failed ({ex.GetType().Name})");
            return false;
        }
        finally
        {
            IsBusy = false;
        }
    }
}
