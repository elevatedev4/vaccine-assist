using System.Threading.Tasks;
using VaccineAssist.Desktop.Services;
using VaccineAssist.Desktop.Settings;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Unit tests for LoginViewModel.TryAutoSignInAsync — the auto-login path
/// App.xaml.cs invokes once, right after showing the Login window (see
/// ShowLoginWindow). Covers the outcomes the brief calls out explicitly:
/// no seeded config, a working seeded config, a seeded config with a bad
/// password (must fall back to the manual form's error state, never
/// crash or loop), and — per review feedback — the post-Sign-out screen,
/// where auto-login must be suppressed even though the exact same seeded
/// config is still sitting in autologin.json.
/// </summary>
public class LoginViewModelAutoLoginTests
{
    private static LoginViewModel CreateViewModel(
        FakeAuthService authService,
        AutoLoginConfig? autoLoginConfig,
        out FakeLocalSettingsService localSettingsService,
        bool allowAutoLogin = true)
    {
        localSettingsService = new FakeLocalSettingsService(new AppSettings());
        return new LoginViewModel(
            authService,
            localSettingsService,
            new AppSettings(),
            new FakeAutoLoginConfigService(autoLoginConfig),
            allowAutoLogin);
    }

    [Fact]
    public async Task DoesNothingWhenNoAutoLoginConfigIsSeeded()
    {
        var authService = new FakeAuthService(AuthResult.Ok());
        var viewModel = CreateViewModel(authService, null, out _, allowAutoLogin: true);

        var signedInRaised = false;
        viewModel.SignedIn += (_, _) => signedInRaised = true;

        await viewModel.TryAutoSignInAsync();

        Assert.Equal(0, authService.SignInCallCount);
        Assert.False(signedInRaised);
        Assert.Null(viewModel.ErrorMessage);
        Assert.False(viewModel.IsBusy);
    }

    [Fact]
    public async Task SignsInAutomaticallyAndRaisesSignedInOnSuccess()
    {
        var authService = new FakeAuthService(AuthResult.Ok());
        var config = new AutoLoginConfig { Email = "pharmacy@example.test", Password = "hunter2" };
        var viewModel = CreateViewModel(authService, config, out var localSettingsService, allowAutoLogin: true);

        var signedInRaised = false;
        viewModel.SignedIn += (_, _) => signedInRaised = true;

        await viewModel.TryAutoSignInAsync();

        Assert.Equal(1, authService.SignInCallCount);
        Assert.Equal("pharmacy@example.test", authService.LastEmail);
        Assert.Equal("hunter2", authService.LastPassword);
        Assert.True(signedInRaised);
        Assert.Null(viewModel.ErrorMessage);
        Assert.False(viewModel.IsBusy);
        Assert.Equal(1, localSettingsService.SaveCallCount);
    }

    [Fact]
    public async Task FallsBackToManualFormOnBadPasswordWithoutCrashingOrLooping()
    {
        var authService = new FakeAuthService(AuthResult.Fail("Sign-in failed: invalid credentials."));
        var config = new AutoLoginConfig { Email = "pharmacy@example.test", Password = "wrong-password" };
        var viewModel = CreateViewModel(authService, config, out _, allowAutoLogin: true);

        var signedInRaised = false;
        viewModel.SignedIn += (_, _) => signedInRaised = true;

        await viewModel.TryAutoSignInAsync();

        Assert.False(signedInRaised);
        Assert.Equal("Sign-in failed: invalid credentials.", viewModel.ErrorMessage);
        // Never left stuck busy - the manual Sign in button must be usable
        // as the fallback, not permanently disabled by a failed auto-login.
        Assert.False(viewModel.IsBusy);
        Assert.True(viewModel.SignInCommand.CanExecute(null));
        // Exactly one attempt - auto-login is never retried on its own.
        Assert.Equal(1, authService.SignInCallCount);
    }

    [Fact]
    public async Task DoesNotAutoSignInOnTheScreenShownAfterSignOut()
    {
        // Mirrors App.xaml.cs's ShowMainWindow LoggedOut handler, which
        // constructs the post-Sign-out LoginViewModel with
        // allowAutoLogin: false — even though autologin.json (here, the
        // fake's config) still has the exact same valid credentials that
        // signed the user in originally. Without the allowAutoLogin gate,
        // TryAutoSignInAsync would silently re-authenticate immediately,
        // making the Sign-out button a no-op.
        var authService = new FakeAuthService(AuthResult.Ok());
        var config = new AutoLoginConfig { Email = "pharmacy@example.test", Password = "hunter2" };
        var viewModel = CreateViewModel(authService, config, out var localSettingsService, allowAutoLogin: false);

        var signedInRaised = false;
        viewModel.SignedIn += (_, _) => signedInRaised = true;

        await viewModel.TryAutoSignInAsync();

        Assert.Equal(0, authService.SignInCallCount);
        Assert.False(signedInRaised);
        Assert.Null(viewModel.ErrorMessage);
        Assert.False(viewModel.IsBusy);
        Assert.Equal(0, localSettingsService.SaveCallCount);
    }

    [Fact]
    public async Task ASettingsSaveFailureDuringSignInStillSignsInInsteadOfCrashing()
    {
        // Regression test for the crash Will hit 2026-08-19/20 ("Clicking
        // lots make it crash" / tabs crashing). Root cause found here:
        // SignInAsync's write to %AppData%\VaccineAssist\settings.json had
        // no catch around it at all — on a real workstation a locked
        // file, a permissions issue, or a roaming-profile sync conflict
        // throws IOException/UnauthorizedAccessException straight out of
        // this method. AsyncRelayCommand.Execute's own catch (see
        // AsyncRelayCommandExceptionTests.cs) would have stopped this
        // specific case from crashing the whole app even before this
        // fix, but the user-visible result without THIS fix would still
        // have been "clicked Sign in, nothing happened, no error shown" —
        // the cloud sign-in had already succeeded and just never got
        // reported. The fix (LoginViewModel.SignInAsync's new inner
        // try/catch around the save) means sign-in completes normally
        // regardless.
        var authService = new FakeAuthService(AuthResult.Ok());
        var config = new AutoLoginConfig { Email = "pharmacy@example.test", Password = "hunter2" };
        var viewModel = CreateViewModel(authService, config, out var localSettingsService, allowAutoLogin: true);
        localSettingsService.ThrowOnSave = new System.IO.IOException("The process cannot access the file because it is being used by another process.");

        var signedInRaised = false;
        viewModel.SignedIn += (_, _) => signedInRaised = true;

        await viewModel.TryAutoSignInAsync();

        Assert.True(signedInRaised);
        Assert.Null(viewModel.ErrorMessage);
        Assert.False(viewModel.IsBusy);
    }
}
