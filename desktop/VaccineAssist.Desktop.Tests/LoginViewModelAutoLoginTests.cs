using System.Threading.Tasks;
using VaccineAssist.Desktop.Services;
using VaccineAssist.Desktop.Settings;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Unit tests for LoginViewModel.TryAutoSignInAsync — the auto-login path
/// App.xaml.cs invokes once, right after showing the Login window (see
/// ShowLoginWindow). Covers the three outcomes the brief calls out
/// explicitly: no seeded config, a working seeded config, and a seeded
/// config with a bad password (must fall back to the manual form's error
/// state, never crash or loop).
/// </summary>
public class LoginViewModelAutoLoginTests
{
    private static LoginViewModel CreateViewModel(
        FakeAuthService authService,
        AutoLoginConfig? autoLoginConfig,
        out FakeLocalSettingsService localSettingsService)
    {
        localSettingsService = new FakeLocalSettingsService(new AppSettings());
        return new LoginViewModel(
            authService,
            localSettingsService,
            new AppSettings(),
            new FakeAutoLoginConfigService(autoLoginConfig));
    }

    [Fact]
    public async Task DoesNothingWhenNoAutoLoginConfigIsSeeded()
    {
        var authService = new FakeAuthService(AuthResult.Ok());
        var viewModel = CreateViewModel(authService, null, out _);

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
        var viewModel = CreateViewModel(authService, config, out var localSettingsService);

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
        var viewModel = CreateViewModel(authService, config, out _);

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
}
