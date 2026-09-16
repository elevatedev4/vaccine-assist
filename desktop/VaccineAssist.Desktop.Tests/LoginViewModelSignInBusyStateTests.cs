using System;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Services;
using VaccineAssist.Desktop.Settings;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Unit tests for LoginViewModel's sign-in busy/timeout state machine —
/// the fix for Will's 2026-09-16 report: "it's just not doing anything"
/// (no spinner/disabled state while a sign-in is in flight, and no
/// timeout) and "it's returning errors in an ugly format." Drives the
/// private SignInAsync through TryAutoSignInAsync — a real awaitable
/// Task, unlike SignInCommand.Execute (async void, no Task to await;
/// LoginViewModelAutoLoginTests.cs/LoginViewModelSessionRestoreTests.cs
/// use the exact same indirection for the same reason). PendingSignIn
/// (TestDoubles.cs) holds the fake auth call "in flight" under test
/// control instead of depending on real wall-clock network timing; the
/// timeout path uses a short signInTimeout override, same approach as
/// StartupSignInCoordinatorTests' short TimeSpans.
/// </summary>
public class LoginViewModelSignInBusyStateTests
{
    private static LoginViewModel CreateViewModel(FakeAuthService authService, TimeSpan? signInTimeout = null)
    {
        var config = new AutoLoginConfig { Email = "pharmacy@example.test", Password = "hunter2" };
        return new LoginViewModel(
            authService,
            new FakeLocalSettingsService(new AppSettings()),
            new AppSettings(),
            new FakeAutoLoginConfigService(config),
            new FakeSessionStore(),
            allowAutoLogin: true,
            signInTimeout: signInTimeout);
    }

    [Fact]
    public async Task IsBusyIsClearedOnSuccessWhenThereIsNoSignedInSubscriberAtAll()
    {
        // handedOff = SignedIn is not null, evaluated right before Invoke()
        // — with zero subscribers this must stay false, so SignInAsync's
        // own `finally` reclaims IsBusy itself rather than leaving it
        // stuck true forever waiting for a subscriber that will never call
        // SetBusy(false).
        var authService = new FakeAuthService(AuthResult.Ok());
        var viewModel = CreateViewModel(authService);

        await viewModel.TryAutoSignInAsync();

        Assert.False(viewModel.IsBusy);
        Assert.True(viewModel.SignInCommand.CanExecute(null));
    }

    [Fact]
    public async Task IsBusyIsTrueWhileTheSignInCallIsInFlightAndFalseOnceItCompletes()
    {
        var authService = new FakeAuthService(AuthResult.Ok());
        var pending = new TaskCompletionSource<AuthResult>();
        authService.PendingSignIn = pending;
        var viewModel = CreateViewModel(authService);

        var signInTask = viewModel.TryAutoSignInAsync();

        // TryAutoSignInAsync runs synchronously up through IsBusy = true
        // and into the (still-pending) auth call, so this observes the
        // in-flight state without racing an async void command.
        Assert.True(viewModel.IsBusy);
        Assert.False(viewModel.SignInCommand.CanExecute(null));

        pending.SetResult(AuthResult.Ok());
        await signInTask;

        Assert.False(viewModel.IsBusy);
        Assert.True(viewModel.SignInCommand.CanExecute(null));
    }

    [Fact]
    public async Task IsBusyGoesFalseAgainAfterAFailedSignIn()
    {
        var authService = new FakeAuthService(AuthResult.Fail("Invalid login credentials"));
        var viewModel = CreateViewModel(authService);

        await viewModel.TryAutoSignInAsync();

        Assert.False(viewModel.IsBusy);
        Assert.Equal(SignInErrorMapper.InvalidCredentialsMessage, viewModel.ErrorMessage);
    }

    [Fact]
    public async Task TimesOutAfterTheConfiguredLimitAndSurfacesTheNetworkMessage()
    {
        var authService = new FakeAuthService(AuthResult.Ok())
        {
            PendingSignIn = new TaskCompletionSource<AuthResult>(), // never completes on its own
        };
        var viewModel = CreateViewModel(authService, signInTimeout: TimeSpan.FromMilliseconds(30));

        await viewModel.TryAutoSignInAsync();

        Assert.Equal(SignInErrorMapper.NetworkOrTimeoutMessage, viewModel.ErrorMessage);
        // The button must be usable again after a timeout, not stuck busy
        // forever just because the abandoned attempt is still out there.
        Assert.False(viewModel.IsBusy);
        Assert.True(viewModel.SignInCommand.CanExecute(null));
    }

    [Fact]
    public async Task ALateSuccessfulCompletionAfterATimeoutNeverRaisesSignedInOrChangesErrorMessage()
    {
        // Mirrors StartupSignInCoordinatorTests.ALateSuccessfulCompletionAfterATimeoutIsIgnored —
        // the whole point of the timeout is that the UI has already moved
        // on and must not be surprised by a very late success (which could
        // otherwise open a second window / trigger a duplicate handoff).
        var authService = new FakeAuthService(AuthResult.Ok());
        var pending = new TaskCompletionSource<AuthResult>();
        authService.PendingSignIn = pending;
        var viewModel = CreateViewModel(authService, signInTimeout: TimeSpan.FromMilliseconds(30));

        var signedInRaised = false;
        viewModel.SignedIn += (_, _) => signedInRaised = true;

        await viewModel.TryAutoSignInAsync();
        Assert.Equal(SignInErrorMapper.NetworkOrTimeoutMessage, viewModel.ErrorMessage);

        pending.SetResult(AuthResult.Ok());
        await Task.Delay(50); // let the abandoned task's continuation run

        Assert.False(signedInRaised);
        Assert.Equal(SignInErrorMapper.NetworkOrTimeoutMessage, viewModel.ErrorMessage);
        Assert.False(viewModel.IsBusy);
    }

    [Fact]
    public async Task IsBusyStaysTrueUntilARealSignedInSubscriberFinishesItsOwnAsyncWork()
    {
        // Reviewer finding (request-changes round), verbatim repro: a
        // SignedIn subscriber shaped like App.xaml.cs's real handler
        // (`async (_, _) => { SetBusy(true); await ...; }`) runs
        // synchronously up to its own first await, then control returns to
        // SignInAsync — which used to fall straight into its OWN
        // `finally { IsBusy = false; }` and stomp the handler's true back
        // to false seconds into a still-in-flight cloud handoff. IsBusy
        // must stay true for as long as the subscriber is still working,
        // not just for the raw auth call.
        var authService = new FakeAuthService(AuthResult.Ok());
        var viewModel = CreateViewModel(authService);
        var handlerGate = new TaskCompletionSource();
        var handlerCompleted = new TaskCompletionSource();

        viewModel.SignedIn += async (_, _) =>
        {
            viewModel.SetBusy(true);
            await handlerGate.Task;
            viewModel.SetBusy(false);
            handlerCompleted.SetResult();
        };

        // SignInAsync's own Task completes here (nothing it awaits itself
        // is left pending — the fake auth call resolves immediately) —
        // the whole point of this test is that its `finally` must NOT
        // have reset IsBusy, since the subscriber is still suspended on
        // handlerGate.Task and now owns the busy state (handedOff).
        await viewModel.TryAutoSignInAsync();
        Assert.True(viewModel.IsBusy);
        Assert.False(viewModel.SignInCommand.CanExecute(null));

        handlerGate.SetResult();
        await handlerCompleted.Task;

        Assert.False(viewModel.IsBusy);
        Assert.True(viewModel.SignInCommand.CanExecute(null));
    }

    [Fact]
    public void SetBusyLetsAnExternalCallerHoldTheSpinnerStateOpen()
    {
        // App.xaml.cs's SignedIn handlers use this to keep the spinner
        // alive across the post-sign-in cloud handoff — see SetBusy's own
        // doc comment for the full root-cause writeup.
        var viewModel = CreateViewModel(new FakeAuthService(AuthResult.Ok()));

        Assert.False(viewModel.IsBusy);
        viewModel.SetBusy(true);
        Assert.True(viewModel.IsBusy);
        Assert.False(viewModel.SignInCommand.CanExecute(null));
        viewModel.SetBusy(false);
        Assert.False(viewModel.IsBusy);
        Assert.True(viewModel.SignInCommand.CanExecute(null));
    }
}
