using System;
using System.Threading;
using System.Threading.Tasks;

namespace VaccineAssist.Desktop.Services;

/// <summary>What StartupSignInCoordinator.RunAsync decided.</summary>
public enum StartupSignInOutcome
{
    /// <summary>The silent attempt succeeded — go straight to MainWindow.</summary>
    SignedIn,

    /// <summary>Show the LoginWindow instead, optionally with LoginMessage
    /// as its ErrorMessage (null means "show the plain manual form, no
    /// error to report" — e.g. the attempt simply returned false with no
    /// exception).</summary>
    ShowLogin,
}

/// <summary>Result of one StartupSignInCoordinator.RunAsync call.</summary>
public sealed class StartupSignInResult
{
    public StartupSignInOutcome Outcome { get; }
    public string? LoginMessage { get; }

    private StartupSignInResult(StartupSignInOutcome outcome, string? loginMessage)
    {
        Outcome = outcome;
        LoginMessage = loginMessage;
    }

    public static StartupSignInResult SignedIn() => new(StartupSignInOutcome.SignedIn, null);

    public static StartupSignInResult ShowLogin(string? message = null) => new(StartupSignInOutcome.ShowLogin, message);
}

/// <summary>
/// Bug fix (Will, 2026-09-14): the "Signing in…" splash (SplashWindow)
/// could hang forever with no way to close it — the silent sign-in
/// attempt (LoginViewModel.TrySilentSignInAsync, a network call with no
/// timeout) could simply never complete, or throw in a way that never
/// got back to App.xaml.cs's `_ = StartSignInFlowAsync();` fire-and-forget
/// call. This class pulls the decision logic (success/failure/timeout/
/// exception/cancel -> MainWindow or LoginWindow-with-a-reason) out of
/// App.xaml.cs into something that can be unit tested without a real WPF
/// Dispatcher or a real IAuthService.
///
/// The constructor's `attempt` delegate is the silent sign-in call itself —
/// App.xaml.cs wires it to `async _ => { await loginViewModel.TrySilentSignInAsync(); return _authService.IsSignedIn; }`.
/// The CancellationToken handed to it is NOT guaranteed to actually abort
/// whatever the delegate is doing (IAuthService/HttpClient calls here take
/// no CancellationToken today) — RunAsync instead races the attempt
/// against a timeout and a cancellation signal and returns as soon as
/// whichever finishes first, WITHOUT waiting for (or ever surfacing) a
/// still-running attempt again. Once RunAsync has returned a decision, a
/// same attempt task that later completes/faults is only ever observed
/// for logging (see ObserveLateCompletion) — it can never cause a second
/// window to appear.
/// </summary>
public sealed class StartupSignInCoordinator
{
    public static readonly TimeSpan DefaultTimeLimit = TimeSpan.FromSeconds(15);

    private readonly Func<CancellationToken, Task<bool>> _attempt;
    private readonly TimeSpan _timeLimit;
    private readonly Action<string>? _log;

    public StartupSignInCoordinator(Func<CancellationToken, Task<bool>> attempt, TimeSpan? timeLimit = null, Action<string>? log = null)
    {
        _attempt = attempt ?? throw new ArgumentNullException(nameof(attempt));
        _timeLimit = timeLimit ?? DefaultTimeLimit;
        _log = log;
    }

    /// <param name="cancellationToken">Cancelled by the splash's Cancel
    /// button/Esc key — see SplashWindow.CancelRequested. Cancellation is
    /// treated exactly like a timeout (the attempt is abandoned, not
    /// necessarily aborted) except for the message shown afterward.</param>
    public async Task<StartupSignInResult> RunAsync(CancellationToken cancellationToken = default)
    {
        Task<bool> attemptTask;
        try
        {
            attemptTask = _attempt(cancellationToken);
        }
        catch (Exception ex)
        {
            _log?.Invoke($"exception starting silent sign-in: {ex.GetType().Name}: {ex.Message}");
            return StartupSignInResult.ShowLogin($"Automatic sign-in failed: {ex.Message}");
        }

        if (attemptTask is null)
        {
            _log?.Invoke("silent sign-in attempt delegate returned a null task");
            return StartupSignInResult.ShowLogin("Automatic sign-in failed: no response.");
        }

        var timeoutTask = Task.Delay(_timeLimit);

        var cancellationSignal = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var registration = RegisterCancellation(cancellationToken, cancellationSignal);

        var completed = await Task.WhenAny(attemptTask, timeoutTask, cancellationSignal.Task).ConfigureAwait(false);

        if (completed == cancellationSignal.Task)
        {
            _log?.Invoke("silent sign-in cancelled by user");
            ObserveLateCompletion(attemptTask);
            return StartupSignInResult.ShowLogin("Sign-in cancelled — sign in manually");
        }

        if (completed == timeoutTask)
        {
            _log?.Invoke($"timed out after {_timeLimit.TotalSeconds:0}s");
            ObserveLateCompletion(attemptTask);
            return StartupSignInResult.ShowLogin("Automatic sign-in timed out — sign in manually");
        }

        try
        {
            var success = await attemptTask.ConfigureAwait(false);
            return success ? StartupSignInResult.SignedIn() : StartupSignInResult.ShowLogin();
        }
        catch (Exception ex)
        {
            _log?.Invoke($"exception during silent sign-in: {ex.GetType().Name}: {ex.Message}");
            return StartupSignInResult.ShowLogin($"Automatic sign-in failed: {ex.Message}");
        }
    }

    /// <summary>
    /// IAsyncDisposable wrapper so the CancellationTokenRegistration is
    /// unregistered as soon as RunAsync is done deciding, whichever task
    /// won — otherwise a long-lived external CancellationTokenSource (the
    /// one App.xaml.cs owns for the whole splash lifetime) would keep this
    /// callback (and its captured TaskCompletionSource) alive for no
    /// reason after the decision has already been made.
    /// </summary>
    private static IAsyncDisposable RegisterCancellation(CancellationToken token, TaskCompletionSource<bool> signal)
    {
        var registration = token.Register(() => signal.TrySetResult(true));
        return new RegistrationDisposable(registration);
    }

    private sealed class RegistrationDisposable : IAsyncDisposable
    {
        private readonly CancellationTokenRegistration _registration;

        public RegistrationDisposable(CancellationTokenRegistration registration)
        {
            _registration = registration;
        }

        public ValueTask DisposeAsync()
        {
            _registration.Dispose();
            return ValueTask.CompletedTask;
        }
    }

    /// <summary>
    /// A timed-out/cancelled attempt keeps running in the background (see
    /// class doc comment) — this only makes sure its eventual completion
    /// or fault is logged and never becomes an UnobservedTaskException; it
    /// never touches any window or fires any event, which is what
    /// guarantees the late completion can't show a second window.
    /// </summary>
    private void ObserveLateCompletion(Task<bool> task)
    {
        _ = task.ContinueWith(
            t =>
            {
                if (t.IsFaulted)
                {
                    var ex = t.Exception?.GetBaseException();
                    _log?.Invoke($"late silent sign-in completion after the decision was already made: {ex?.GetType().Name}: {ex?.Message}");
                }
                else if (t.IsCompletedSuccessfully)
                {
                    _log?.Invoke($"late silent sign-in completion after the decision was already made: result={t.Result}");
                }
            },
            TaskScheduler.Default);
    }
}
