using System;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Services;
using VaccineAssist.Desktop.Settings;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Unit tests for LoginViewModel.HasStoredCredential/TrySilentSignInAsync —
/// the 90-day persisted-session path (Will, 2026-09-13). Same hand-rolled
/// fake style as LoginViewModelAutoLoginTests.cs; FakeSessionStore
/// (TestDoubles.cs) stands in for the DPAPI/file-backed SessionStore.
/// </summary>
public class LoginViewModelSessionRestoreTests
{
    private static LoginViewModel CreateViewModel(
        FakeAuthService authService,
        FakeSessionStore sessionStore,
        AutoLoginConfig? autoLoginConfig = null,
        bool allowAutoLogin = true)
    {
        return new LoginViewModel(
            authService,
            new FakeLocalSettingsService(new AppSettings()),
            new AppSettings(),
            new FakeAutoLoginConfigService(autoLoginConfig),
            sessionStore,
            allowAutoLogin);
    }

    [Fact]
    public void HasStoredCredentialIsFalseWhenNothingIsStored()
    {
        var viewModel = CreateViewModel(new FakeAuthService(AuthResult.Ok()), new FakeSessionStore());
        Assert.False(viewModel.HasStoredCredential());
    }

    [Fact]
    public void HasStoredCredentialIsTrueForANotYetExpiredSession()
    {
        var session = new PersistedSession("access", "refresh", DateTime.UtcNow.AddDays(-10));
        var viewModel = CreateViewModel(new FakeAuthService(AuthResult.Ok()), new FakeSessionStore(session));

        Assert.True(viewModel.HasStoredCredential());
    }

    [Fact]
    public void HasStoredCredentialIsFalseForAnExpiredSessionWithNoAutoLoginConfig()
    {
        var session = new PersistedSession("access", "refresh", DateTime.UtcNow.AddDays(-91));
        var viewModel = CreateViewModel(new FakeAuthService(AuthResult.Ok()), new FakeSessionStore(session));

        Assert.False(viewModel.HasStoredCredential());
    }

    [Fact]
    public void HasStoredCredentialFallsBackToAutoLoginConfigWhenSessionExpired()
    {
        var session = new PersistedSession("access", "refresh", DateTime.UtcNow.AddDays(-91));
        var config = new AutoLoginConfig { Email = "pharmacy@example.test", Password = "hunter2" };
        var viewModel = CreateViewModel(new FakeAuthService(AuthResult.Ok()), new FakeSessionStore(session), config);

        Assert.True(viewModel.HasStoredCredential());
    }

    [Fact]
    public void HasStoredCredentialIsFalseWhenAutoLoginIsDisallowedEvenIfSessionIsFresh()
    {
        // Mirrors the post-Sign-out screen (App.xaml.cs constructs it with
        // allowAutoLogin: false) — must never silently re-offer the
        // credential Sign out just deleted/ignored.
        var session = new PersistedSession("access", "refresh", DateTime.UtcNow);
        var viewModel = CreateViewModel(new FakeAuthService(AuthResult.Ok()), new FakeSessionStore(session), allowAutoLogin: false);

        Assert.False(viewModel.HasStoredCredential());
    }

    [Fact]
    public async Task TrySilentSignInRestoresAFreshSessionAndRaisesSignedIn()
    {
        var session = new PersistedSession("stale-access", "refresh-token", DateTime.UtcNow.AddDays(-5));
        var sessionStore = new FakeSessionStore(session);
        var authService = new FakeAuthService(AuthResult.Ok());
        var viewModel = CreateViewModel(authService, sessionStore);

        var signedInRaised = false;
        viewModel.SignedIn += (_, _) => signedInRaised = true;

        await viewModel.TrySilentSignInAsync();

        Assert.True(signedInRaised);
        Assert.Equal(1, authService.TryRestoreSessionCallCount);
        Assert.Equal("stale-access", authService.LastRestoreAccessToken);
        Assert.Equal("refresh-token", authService.LastRestoreRefreshToken);
        Assert.Equal(0, authService.SignInCallCount); // never falls through to autologin once restore succeeds
        Assert.Null(viewModel.ErrorMessage);
        Assert.False(viewModel.IsBusy);
    }

    [Fact]
    public async Task TrySilentSignInReSavesRotatedTokensButKeepsTheOriginalIssuedAt()
    {
        var originalIssuedAt = DateTime.UtcNow.AddDays(-30);
        var session = new PersistedSession("stale-access", "refresh-token", originalIssuedAt);
        var sessionStore = new FakeSessionStore(session);
        var authService = new FakeAuthService(AuthResult.Ok());

        var viewModel = CreateViewModel(authService, sessionStore);
        await viewModel.TrySilentSignInAsync();

        Assert.Equal(1, sessionStore.SaveCallCount);
        Assert.NotNull(sessionStore.LastSaved);
        Assert.Equal("fake-restored-access-token", sessionStore.LastSaved!.AccessToken);
        Assert.Equal("fake-restored-refresh-token", sessionStore.LastSaved.RefreshToken);
        // The 90-day clock tracks the last INTERACTIVE sign-in, not this
        // silent restore — the original timestamp must survive unchanged.
        Assert.Equal(originalIssuedAt, sessionStore.LastSaved.IssuedAtUtc);
    }

    [Fact]
    public async Task TrySilentSignInFallsBackToAutoLoginWhenNoSessionIsStored()
    {
        var config = new AutoLoginConfig { Email = "pharmacy@example.test", Password = "hunter2" };
        var authService = new FakeAuthService(AuthResult.Ok());
        var viewModel = CreateViewModel(authService, new FakeSessionStore(), config);

        var signedInRaised = false;
        viewModel.SignedIn += (_, _) => signedInRaised = true;

        await viewModel.TrySilentSignInAsync();

        Assert.Equal(0, authService.TryRestoreSessionCallCount);
        Assert.Equal(1, authService.SignInCallCount);
        Assert.True(signedInRaised);
    }

    [Fact]
    public async Task TrySilentSignInFallsBackToAutoLoginWhenSessionRestoreFails()
    {
        var session = new PersistedSession("stale-access", "revoked-refresh-token", DateTime.UtcNow.AddDays(-5));
        var sessionStore = new FakeSessionStore(session);
        var config = new AutoLoginConfig { Email = "pharmacy@example.test", Password = "hunter2" };
        var authService = new FakeAuthService(AuthResult.Ok())
        {
            RestoreResult = AuthResult.Fail("refresh token revoked"),
        };
        var viewModel = CreateViewModel(authService, sessionStore, config);

        var signedInRaised = false;
        viewModel.SignedIn += (_, _) => signedInRaised = true;

        await viewModel.TrySilentSignInAsync();

        Assert.Equal(1, authService.TryRestoreSessionCallCount);
        Assert.Equal(1, authService.SignInCallCount);
        Assert.True(signedInRaised);
        // A failed silent restore is not shown as an error — only a failed
        // autologin.json attempt (unchanged TryAutoSignInAsync behavior) would be.
        Assert.Null(viewModel.ErrorMessage);
    }

    [Fact]
    public async Task TrySilentSignInDoesNothingWhenNotAllowed()
    {
        var session = new PersistedSession("access", "refresh", DateTime.UtcNow);
        var authService = new FakeAuthService(AuthResult.Ok());
        var viewModel = CreateViewModel(authService, new FakeSessionStore(session), allowAutoLogin: false);

        await viewModel.TrySilentSignInAsync();

        Assert.Equal(0, authService.TryRestoreSessionCallCount);
        Assert.Equal(0, authService.SignInCallCount);
    }

    [Fact]
    public async Task TrySilentSignInIgnoresAnExpiredPersistedSessionAndFallsBackToAutoLogin()
    {
        var session = new PersistedSession("access", "refresh", DateTime.UtcNow.AddDays(-91));
        var config = new AutoLoginConfig { Email = "pharmacy@example.test", Password = "hunter2" };
        var authService = new FakeAuthService(AuthResult.Ok());
        var viewModel = CreateViewModel(authService, new FakeSessionStore(session), config);

        await viewModel.TrySilentSignInAsync();

        Assert.Equal(0, authService.TryRestoreSessionCallCount); // expired — never even attempted
        Assert.Equal(1, authService.SignInCallCount);
    }

    [Fact]
    public async Task SuccessfulSignInPersistsANewSessionWithAFreshIssuedAt()
    {
        // Goes through TryAutoSignInAsync (fully awaitable, no ICommand
        // fire-and-forget timing to work around) since it calls the exact
        // same private SignInAsync a manual click does — see
        // LoginViewModel.SignInCommand.
        var sessionStore = new FakeSessionStore();
        var authService = new FakeAuthService(AuthResult.Ok());
        var config = new AutoLoginConfig { Email = "pharmacy@example.test", Password = "hunter2" };
        var viewModel = CreateViewModel(authService, sessionStore, config);

        var before = DateTime.UtcNow;
        await viewModel.TryAutoSignInAsync();
        var after = DateTime.UtcNow;

        Assert.Equal(1, sessionStore.SaveCallCount);
        Assert.NotNull(sessionStore.LastSaved);
        Assert.Equal("fake-token", sessionStore.LastSaved!.AccessToken);
        Assert.Equal("fake-refresh-token", sessionStore.LastSaved.RefreshToken);
        Assert.InRange(sessionStore.LastSaved.IssuedAtUtc, before.AddSeconds(-1), after.AddSeconds(1));
    }
}
