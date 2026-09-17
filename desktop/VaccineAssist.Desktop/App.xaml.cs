using System;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;
using VaccineAssist.Desktop.Logging;
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
    private ISessionStore _sessionStore = null!;
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

        // CRASH FIX (Will, 2026-08-19/20: "Clicking lots make it crash" /
        // "App crashes when I try to look at several tabs"). Root causes
        // found in the ViewModels/commands themselves are fixed at their
        // source (see AsyncRelayCommand.Execute's new catch clause and
        // LoginViewModel.SignInAsync's new catch around the settings
        // save) — those give the nicer per-tab inline ErrorMessage UX.
        // These three handlers are the last-resort backstop for anything
        // that still isn't caught somewhere more specific: instead of the
        // .NET default (silently terminate the process with no trace),
        // log what happened to %AppData%\VaccineAssist\logs\app.log and
        // tell the user, then keep the app running wherever that's
        // actually possible.
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += OnAppDomainUnhandledException;
        TaskScheduler.UnobservedTaskException += OnUnobservedTaskException;

        // V-T28 item 3 (Will's brief): "the desktop log must name the log
        // file's full path at startup ... so Will can find them" — the
        // very first line ever written to a fresh log file is now that
        // file's own path (UiaTreeDumper.DumpWindowToFile already logs the
        // UIA-dump path whenever one is written — see that method — so
        // between the two, both paths this brief asked for are always
        // discoverable from "Copy logs").
        AppFileLog.Log($"[Startup] Log file: {AppFileLog.LogFilePath}");

        _localSettingsService = new LocalSettingsService();
        _autoLoginConfigService = new AutoLoginConfigService();
        _sessionStore = new SessionStore();
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
        // Kept constructed (harmless, side-effect-free) even though nothing
        // currently consumes it — it backed the old full-form EntryView,
        // which was repurposed 2026-08-19 into a lightweight hotkey
        // status tab that doesn't need it. Left in place rather than
        // removed in case a future screen needs the IPioneerEntryAutomation
        // abstraction again.
        _pioneerEntryAutomation = new PioneerEntryAutomationStub();
        // V-T3: the ONE sequence implementation shipped in phase 1 — see
        // PioneerEntryAutomation/Sequencing/PlaceholderVaccineEntrySequence.cs.
        // Swapping in the real sequence once vaccine-add-new.mxe is available
        // is a one-line change here, not a rebuild of MainWindow/DataEntryPopupViewModel.
        // _settings.PriorityValue (2026-09-13 priority-popup fix) is threaded
        // through here so a workstation can change it via settings.json with
        // no rebuild — see SendF3AndDismissPreEntryDialogsStep's own doc comment.
        _pioneerEntrySequence = new PlaceholderVaccineEntrySequence(_settings.PriorityValue);

        _ = StartSignInFlowAsync();
    }

    /// <summary>
    /// Startup sign-in orchestration (Will, 2026-09-13 — "The login screen
    /// is still showing momentarily and then disappearing without me
    /// needing to do anything ... don't let it flash the way it is now."
    /// / "If a user already has a login on the computer, don't show the
    /// login screen at all"). Replaces the old
    /// "Show LoginWindow immediately, then try auto-login in the
    /// background" flow (which is exactly what caused the flash) with:
    ///   1. Build the LoginViewModel but do NOT show it yet.
    ///   2. If there's a stored credential worth trying at all
    ///      (LoginViewModel.HasStoredCredential — a not-yet-90-day-expired
    ///      session.json, or a seeded autologin.json), show a tiny
    ///      borderless "Signing in…" splash instead and await the full
    ///      silent attempt (TrySilentSignInAsync: session-restore, then
    ///      autologin.json) before deciding what to do next.
    ///   3. If that succeeded, go straight to MainWindow — the Login
    ///      window is never shown at all, so it can't flash.
    ///   4. If nothing was stored, or the silent attempt failed, show the
    ///      (already-constructed, so any ErrorMessage from the failed
    ///      attempt carries over) LoginViewModel's window now.
    ///
    /// BUG FIX (Will, 2026-09-14 — "shows the splash floating mid-screen
    /// and never moves on; there is no way to close it"): this whole
    /// method used to have no top-level try/catch, no timeout on step 2's
    /// await, and called ShowMainWindow() (which can throw — see
    /// MainWindow's TrayIconController comment) BEFORE splash.Close(), so
    /// any of the following left the splash on screen forever with the
    /// exception silently swallowed by the `_ = StartSignInFlowAsync();`
    /// fire-and-forget call in OnStartup:
    ///   (a) TrySilentSignInAsync's underlying network call hanging with
    ///       no timeout;
    ///   (b) ShowMainWindow() throwing, so splash.Close() was never
    ///       reached;
    ///   (c) an exception escaping TrySilentSignInAsync itself.
    /// Now: the silent attempt is capped at 15s and cancellable from the
    /// splash's Cancel button/Esc (StartupSignInCoordinator), the whole
    /// method is wrapped in try/catch, and every exit path is funneled
    /// through EndStartupWithLoginWindow/ShowMainWindowThenCloseSplashAsync
    /// so the splash is always closed and some window always ends up on
    /// screen — see those two methods.
    /// </summary>
    private async Task StartSignInFlowAsync()
    {
        var loginViewModel = new LoginViewModel(_authService, _localSettingsService, _settings, _autoLoginConfigService, _sessionStore, allowAutoLogin: true);
        SplashWindow? splash = null;
        // Defensive guard against ever ending the startup flow with two
        // windows shown (or none) — see StartupSignInCoordinator's doc
        // comment on late/abandoned attempt completions never reaching
        // here a second time; this is belt-and-suspenders on top of that.
        var startupResolved = false;

        try
        {
            var hasStoredCredential = loginViewModel.HasStoredCredential();
            AppFileLog.Log(hasStoredCredential
                ? "[Startup] silent sign-in: stored credential found"
                : "[Startup] silent sign-in: none");

            if (!hasStoredCredential)
            {
                EndStartupWithLoginWindow(loginViewModel, null, ref startupResolved);
                return;
            }

            splash = new SplashWindow();
            MainWindow = splash;
            splash.Show();

            using var cancelSource = new CancellationTokenSource();
            splash.CancelRequested += (_, _) =>
            {
                AppFileLog.Log("[Startup] silent sign-in: cancel requested from splash");
                try
                {
                    cancelSource.Cancel();
                }
                catch (ObjectDisposedException)
                {
                    // RunAsync already returned and cancelSource was
                    // disposed — nothing left to cancel.
                }
            };

            var coordinator = new StartupSignInCoordinator(
                attempt: async _ =>
                {
                    await loginViewModel.TrySilentSignInAsync();
                    return _authService.IsSignedIn;
                },
                timeLimit: TimeSpan.FromSeconds(15),
                log: message => AppFileLog.Log($"[Startup] {message}"));

            var result = await coordinator.RunAsync(cancelSource.Token);

            if (result.Outcome == StartupSignInOutcome.SignedIn)
            {
                // ORDERING FIX (Will's app.log, 2026-09-16 — see
                // ShowMainWindowAndInitializeAsync's own doc comment for
                // the full diagnosis): startupResolved is claimed here,
                // BEFORE the await, matching every other branch's
                // resolve-then-act shape — ref parameters can't cross an
                // await, so the actual "show MainWindow, then close the
                // splash" work is a plain async call instead of routing
                // through EndStartupWithMainWindow(ref ...) the way it used
                // to when PrepareMainCloudPageViewAsync ran to completion
                // BEFORE this point.
                startupResolved = true;
                await ShowMainWindowThenCloseSplashAsync(loginViewModel, splash);
            }
            else
            {
                splash.Close();
                EndStartupWithLoginWindow(loginViewModel, result.LoginMessage, ref startupResolved);
            }
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("StartSignInFlowAsync", ex);
            try
            {
                splash?.Close();
            }
            catch (Exception closeEx)
            {
                AppFileLog.LogException("StartSignInFlowAsync (splash close)", closeEx);
            }

            EndStartupWithLoginWindow(loginViewModel, $"Automatic sign-in failed: {ex.Message}", ref startupResolved);
        }
    }

    /// <summary>Success path for StartSignInFlowAsync — tries MainWindow
    /// (via ShowMainWindowAndInitializeAsync, shared with the two
    /// manual-sign-in paths below) and only THEN closes the splash,
    /// whichever way it goes, so a MainWindow construction failure (see
    /// MainWindow's TrayIconController doc comment for one real cause) can
    /// never leave the splash as the last window standing. Falls back to
    /// the manual LoginWindow (with the ErrorMessage already set) if
    /// MainWindow couldn't be shown. A plain async method rather than the
    /// old EndStartupWithMainWindow(ref bool) — ref/out parameters aren't
    /// allowed on async methods, and this is only ever called once
    /// (immediately after the caller itself claims startupResolved), so
    /// the ref guard wasn't actually needed here.</summary>
    private async Task ShowMainWindowThenCloseSplashAsync(LoginViewModel loginViewModel, SplashWindow splash)
    {
        var shown = await ShowMainWindowAndInitializeAsync(loginViewModel, splash);

        try
        {
            splash.Close();
        }
        catch (Exception closeEx)
        {
            AppFileLog.LogException("StartSignInFlowAsync (splash close)", closeEx);
        }

        if (shown)
        {
            AppFileLog.Log("[Startup] MainWindow shown");
        }
        else
        {
            // ShowMainWindowAndInitializeAsync already logged, alerted, and
            // set an ErrorMessage — no additional reason to pass here.
            var loginWindowShown = false;
            EndStartupWithLoginWindow(loginViewModel, null, ref loginWindowShown);
        }
    }

    /// <summary>Failure/timeout/cancel/no-stored-credential path for
    /// StartSignInFlowAsync — always ends with a usable LoginWindow, never
    /// with just the splash. <paramref name="errorMessage"/> is set as the
    /// window's ErrorMessage when non-null (null means "nothing was
    /// stored, show the plain manual form").</summary>
    private void EndStartupWithLoginWindow(LoginViewModel loginViewModel, string? errorMessage, ref bool startupResolved)
    {
        if (startupResolved)
        {
            return;
        }
        startupResolved = true;

        if (errorMessage is not null)
        {
            loginViewModel.SetErrorMessage(MapStartupErrorMessage(errorMessage));
        }

        AppFileLog.Log("[Startup] LoginWindow shown");
        ShowLoginWindowWithViewModel(loginViewModel);
    }

    /// <summary>
    /// StartupSignInCoordinator's own LoginMessage is mostly already plain
    /// English ("Automatic sign-in timed out — sign in manually", "Sign-in
    /// cancelled — sign in manually") and is left exactly as-is — it also
    /// backs that class's own tests (StartupSignInCoordinatorTests.cs),
    /// which intentionally assert the RAW reason for diagnostic purposes
    /// and must keep passing unchanged. Only its two exception-carrying
    /// branches (RunAsync's own catches, both shaped
    /// "Automatic sign-in failed: &lt;ex.Message&gt;") — and this method's
    /// caller's own equivalently-shaped outer-catch message — can put raw/
    /// technical text on screen (Will, 2026-09-16: "it's returning errors
    /// in an ugly format, needs to be user friendly"); this maps just the
    /// embedded reason through SignInErrorMapper, the same funnel
    /// LoginViewModel.SignInAsync uses for the manual sign-in form.
    /// </summary>
    private static string MapStartupErrorMessage(string errorMessage)
    {
        const string prefix = "Automatic sign-in failed: ";
        return errorMessage.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            ? SignInErrorMapper.Map(errorMessage[prefix.Length..])
            : errorMessage;
    }

    /// <summary>
    /// Shows a LoginWindow for an ALREADY-CONSTRUCTED LoginViewModel —
    /// used both by StartSignInFlowAsync above (the silent attempt, if
    /// any, already ran; showing this window is the fallback) and
    /// implicitly covers "nothing was stored at all," where
    /// TrySilentSignInAsync was never even called. A local `signedIn`
    /// flag (not a shared field) tracks whether THIS window's Closed
    /// event should shut the app down — closing a login window without
    /// signing in means quit; closing it because sign-in just succeeded
    /// (see below) does not.
    /// </summary>
    private void ShowLoginWindowWithViewModel(LoginViewModel loginViewModel)
    {
        var loginWindow = new LoginWindow(loginViewModel);
        var signedIn = false;

        loginViewModel.SignedIn += async (_, _) =>
        {
            // ROOT CAUSE FIX (Will, 2026-09-16 — "I just tried to sign in
            // and it's just not doing anything"): LoginViewModel.SignInAsync
            // hands busy-state ownership to THIS handler right before
            // invoking it (see LoginViewModel's handedOff field) — without
            // that (reviewer's request-changes round), IsBusy/the button's
            // spinner would drop the instant the raw Supabase call
            // finished, well before the cloud handoff below (up to ~12s
            // WebView2 init + up to 10s handoff) actually completes.
            // SetBusy(true) here keeps the spinner alive for that whole
            // gap; the try/finally guarantees SetBusy(false) runs on every
            // exit — the failure branch below, AND an unexpected exception
            // from ShowMainWindowAndInitializeAsync (not documented to
            // throw, but this must not leave the button permanently
            // disabled if it ever does) — success instead closes this
            // window, so there's nothing left to un-busy.
            loginViewModel.SetBusy(true);
            try
            {
                // Part 1 (Will's brief): manual sign-in also gets the
                // WebView2 + cloud session handoff BEFORE MainWindow is
                // usable — see ShowMainWindowAndInitializeAsync's own doc
                // comment. This LoginWindow is still up (showing "Signing
                // in…"/busy state via LoginViewModel.IsBusy, and kept on
                // top of the not-yet-ready MainWindow — see that method)
                // while that runs.
                if (await ShowMainWindowAndInitializeAsync(loginViewModel, loginWindow))
                {
                    signedIn = true;
                    loginWindow.Close();
                }
                // else: stay on this LoginWindow — ShowMainWindowAndInitializeAsync
                // already logged, alerted, and set an ErrorMessage explaining why.
            }
            finally
            {
                if (!signedIn)
                {
                    loginViewModel.SetBusy(false);
                }
            }
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
    /// Shows a fresh LoginWindow with a brand-new LoginViewModel — used
    /// ONLY by BuildMainWindow's Sign-out handler.
    /// <paramref name="attemptAutoLogin"/> is passed straight through to
    /// LoginViewModel's allowAutoLogin constructor parameter; it is
    /// always false here. Without that, a workstation with autologin.json
    /// (or the 90-day session.json — deleted on sign-out anyway, see
    /// below, but autologin.json is untouched by sign-out) seeded would
    /// silently re-authenticate the instant Sign out finished, making the
    /// button a no-op — Sign-out must always land on the manual form, not
    /// retry the same shared credentials.
    /// </summary>
    private void ShowLoginWindow(bool attemptAutoLogin)
    {
        var loginViewModel = new LoginViewModel(_authService, _localSettingsService, _settings, _autoLoginConfigService, _sessionStore, attemptAutoLogin);
        var loginWindow = new LoginWindow(loginViewModel);
        var signedIn = false;

        loginViewModel.SignedIn += async (_, _) =>
        {
            // Keep the spinner/busy state alive across the handoff, and
            // guarantee SetBusy(false) on every exit (including an
            // unexpected exception) — see ShowLoginWindowWithViewModel's
            // SignedIn handler (same fix, same reasoning) and
            // LoginViewModel.SetBusy's doc comment.
            loginViewModel.SetBusy(true);
            try
            {
                // Part 1 — same handoff-before-MainWindow sequencing as
                // ShowLoginWindowWithViewModel's SignedIn handler above.
                if (await ShowMainWindowAndInitializeAsync(loginViewModel, loginWindow))
                {
                    signedIn = true;
                    loginWindow.Close();
                }
                // else: stay on this LoginWindow — ShowMainWindowAndInitializeAsync
                // already logged, alerted, and set an ErrorMessage explaining why.
            }
            finally
            {
                if (!signedIn)
                {
                    loginViewModel.SetBusy(false);
                }
            }
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
    /// Part 1 (Will's brief), ORDERING FIX (Will's app.log, 2026-09-16):
    /// builds MainWindow (hosting a fresh, not-yet-initialized CloudPageView
    /// — see MainWindow.xaml's own doc comment for the one-tab-row change)
    /// and Shows() it BEFORE running WebView2 init/the cloud sign-in
    /// handoff, instead of after.
    ///
    /// DIAGNOSIS: app.log showed the WebView2 environment created in 5ms,
    /// but EnsureCoreWebView2Async only completing ~200ms AFTER "MainWindow
    /// shown" — 45 SECONDS after it actually started (the full
    /// InitWaitPolicy.Timeout cap). A WPF WebView2 control can't create its
    /// CoreWebView2Controller until it has a parent HWND, i.e. until the
    /// window hosting it has actually been Show()n. The OLD "sign-in-before-
    /// show" order (commit a7973b5) called EnsureInitializedAsync on a
    /// CloudPageView that belonged to no window yet — no HWND ever existed
    /// for the wait to succeed against, so it was *guaranteed* to run out
    /// the clock every time, not just occasionally; the earlier 12s-cap
    /// version and the original "hangs forever" bug were the same root
    /// cause.
    ///
    /// FIX: build+Show() MainWindow first (CloudPageView.autoInitializeOnLoad
    /// is false for this instance — see that constructor param's doc
    /// comment — so nothing auto-navigates to "/" the instant it loads),
    /// set ShowActivated = false so it neither steals focus nor comes in
    /// front of whichever "signing in" window (<paramref
    /// name="windowToKeepOnTop"/> — the splash, or a LoginWindow) is
    /// already on screen, THEN await WebView2 init + the token handoff via
    /// InitializeAndHandoffCloudPageViewAsync. Only once that's done does
    /// the caller close/replace windowToKeepOnTop, revealing MainWindow
    /// already on "/" (signed in, on handoff success) — never a flash of
    /// the cloud's own unauthenticated login form.
    ///
    /// Returns false (never throws) if MainWindow itself couldn't be
    /// constructed/shown (e.g. TrayIconController — see MainWindow's field
    /// comment for one real cause) — alerts + sets loginViewModel's
    /// ErrorMessage in that case so the caller's still-visible "signing in"
    /// window can explain why. A WebView2 init or handoff failure AFTER
    /// that point is never fatal to MainWindow itself — see
    /// InitializeAndHandoffCloudPageViewAsync's own doc comment — so this
    /// still returns true.
    /// </summary>
    private async Task<bool> ShowMainWindowAndInitializeAsync(LoginViewModel loginViewModel, Window windowToKeepOnTop)
    {
        var cloudPageView = new CloudPageView(_settings.CloudApiBaseUrl, autoInitializeOnLoad: false);

        MainWindow mainWindowInstance;
        try
        {
            mainWindowInstance = BuildMainWindow(cloudPageView);
            MainWindow = mainWindowInstance;
            mainWindowInstance.ShowActivated = false;
            mainWindowInstance.Show();

            // Belt-and-suspenders on top of ShowActivated = false above:
            // reclaim focus/foreground for whichever "signing in" window is
            // already up, in case Show() still nudged the (blank, not-yet-
            // ready) MainWindow in front of it on some Windows version/
            // window-manager configuration.
            windowToKeepOnTop.Activate();
        }
        catch (Exception ex)
        {
            // 2026-09-14 (Will, live bug — "Signed in, but the main window
            // couldn't be opened" with no way to tell what actually threw):
            // AppFileLog.LogException now walks the FULL exception chain
            // (type/message/stack/inner exceptions), and the exception's
            // type+message are now surfaced right in the LoginWindow's
            // ErrorMessage (previously only the generic sentence, with the
            // detail going solely to a MessageBox that may not have been
            // seen/screenshotted) — so the next report names the real cause.
            AppFileLog.LogException("ShowMainWindowAndInitializeAsync", ex);
            MessageBox.Show(
                "Vaccine Assist signed in, but the main window couldn't be opened.\n\n" +
                $"{ex.GetType().Name}: {ex.Message}",
                "Vaccine Assist",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
            loginViewModel.SetErrorMessage(
                $"Signed in, but the main window couldn't be opened: {ex.GetType().Name}: {ex.Message}. Details in the log.");
            return false;
        }

        await InitializeAndHandoffCloudPageViewAsync(cloudPageView);

        // The window is fully ready now — make sure IT (not
        // windowToKeepOnTop, which the caller is about to close/hide) ends
        // up with focus once that happens, rather than relying on Windows
        // to pick a new foreground window on its own.
        mainWindowInstance.Activate();

        return true;
    }

    /// <summary>
    /// Runs WebView2 init and — if the just-completed sign-in produced
    /// tokens — the cloud sign-in handoff (POSTs to
    /// cloud/app/api/auth/desktop-handoff/route.ts) on a CloudPageView that
    /// ShowMainWindowAndInitializeAsync has ALREADY added to MainWindow's
    /// visual tree and Show()n — see that method's own doc comment for why
    /// this order (not the reverse) is what actually lets
    /// EnsureCoreWebView2Async succeed instead of always timing out.
    ///
    /// Never throws — a WebView2 init failure here just means MainWindow's
    /// CloudPageView will show ITS OWN "couldn't load" panel once actually
    /// visible (see CloudPageView.EnsureInitializedAsync's existing
    /// try/catch), and a handoff timeout/failure just means the page shows
    /// its own cloud login form — both explicitly acceptable per the
    /// brief ("on timeout/failure log a [Startup] line and continue — the
    /// page will just show its own login"). CloudPageView.PerformDesktopHandoffAsync
    /// itself now logs the concrete reason a handoff failed (WebErrorStatus/
    /// HTTP status, or a timed-out/exception detail) — see that method's
    /// doc comment — so the generic "[Startup] ... failed or timed out"
    /// lines below are always backed by a preceding [CloudPageView] line
    /// naming the actual cause.
    ///
    /// LATE-RECOVERY: EnsureInitializedAsync waits up to InitWaitPolicy.Timeout
    /// (45s) before giving up — now effectively a defensive cap rather than
    /// the guaranteed-to-fire timeout it was before the Show()-before-init
    /// ordering fix, since the HWND this needs already exists by the time
    /// this runs. If the wait still times out (e.g. a genuinely broken/very
    /// slow WebView2 Evergreen Runtime), IsCoreWebView2Ready is false here
    /// and the handoff is skipped for now (never double-waits by calling
    /// PerformDesktopHandoffAsync against a not-yet-ready control) — but
    /// CloudPageView.InitializedLate is subscribed so that if the abandoned
    /// attempt succeeds on its own moments later, the handoff still runs
    /// then, with whatever tokens are current at that point.
    /// </summary>
    private async Task InitializeAndHandoffCloudPageViewAsync(CloudPageView cloudPageView)
    {
        try
        {
            await cloudPageView.EnsureInitializedAsync();

            if (!cloudPageView.IsCoreWebView2Ready)
            {
                AppFileLog.Log("[Startup] cloud session handoff: deferred (WebView2 init timed out or failed) — will retry if it recovers on its own");
                cloudPageView.InitializedLate += async (_, _) =>
                {
                    try
                    {
                        if (_authService.AccessToken is { Length: > 0 } lateAccessToken &&
                            _authService.RefreshToken is { Length: > 0 } lateRefreshToken)
                        {
                            var lateHandoffOk = await cloudPageView.PerformDesktopHandoffAsync(
                                lateAccessToken, lateRefreshToken, TimeSpan.FromSeconds(10));
                            AppFileLog.Log(lateHandoffOk
                                ? "[Startup] late cloud session handoff (post-timeout recovery): ok"
                                : "[Startup] late cloud session handoff (post-timeout recovery): failed or timed out — see the preceding [CloudPageView] line for the concrete reason");
                        }
                    }
                    catch (Exception ex)
                    {
                        AppFileLog.LogException("InitializeAndHandoffCloudPageViewAsync.InitializedLate", ex);
                    }
                };
            }
            else if (_authService.AccessToken is { Length: > 0 } accessToken &&
                _authService.RefreshToken is { Length: > 0 } refreshToken)
            {
                var handoffOk = await cloudPageView.PerformDesktopHandoffAsync(accessToken, refreshToken, TimeSpan.FromSeconds(10));
                AppFileLog.Log(handoffOk
                    ? "[Startup] cloud session handoff: ok"
                    : "[Startup] cloud session handoff: failed or timed out — see the preceding [CloudPageView] line for the concrete reason");
            }
            else
            {
                // Shouldn't happen right after a successful sign-in, but
                // degrade to a plain "/" load rather than leaving the
                // WebView2 on a blank page if it ever does.
                AppFileLog.Log("[Startup] cloud session handoff: skipped (no tokens available)");
                cloudPageView.NavigateToPath("/");
            }
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("InitializeAndHandoffCloudPageViewAsync", ex);
        }
    }

    /// <summary>
    /// Constructs (but does not Show()) the post-login shell — split out
    /// of what used to be a single ShowMainWindow(cloudPageView) method so
    /// ShowMainWindowAndInitializeAsync can Show() the window BEFORE
    /// WebView2 init runs (see that method's doc comment) while still
    /// wiring the same LoggedOut/Closed handlers here. Same local-flag
    /// pattern as ShowLoginWindow: closing MainWindow via Sign out (which
    /// immediately opens a new LoginWindow) must not also shut the app
    /// down; closing it via the window chrome/Alt+F4 must.
    /// </summary>
    private MainWindow BuildMainWindow(CloudPageView cloudPageView)
    {
        // V-T-single-nav (Will's brief, 2026-09-14): MainWindow now hosts
        // exactly ONE CloudPageView instead of five, one per former tab.
        // See MainWindow.xaml.cs's own doc comment.
        var mainWindow = new MainWindow(
            _authService, _vaccineApiService, _clipboardService,
            _pioneerEntrySequence, cloudPageView, _localSettingsService, _settings);
        var loggingOut = false;

        mainWindow.LoggedOut += (_, _) =>
        {
            loggingOut = true;
            // Will, 2026-09-13: sign out must actually sign out — delete
            // the persisted 90-day session so the next launch doesn't
            // silently restore right back in. (autologin.json, a
            // separate/older per-machine mechanism, is left untouched;
            // ShowLoginWindow's attemptAutoLogin: false below already
            // covers suppressing that one on this screen.)
            _sessionStore.Delete();
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

        return mainWindow;
    }

    /// <summary>
    /// The primary crash backstop: any exception raised while WPF's
    /// Dispatcher processes a UI-thread callback (routed events like
    /// Button.Click, async-void continuations posted back to the UI
    /// thread — which is how AsyncRelayCommand.Execute's own exceptions
    /// would surface if its new catch clause were ever bypassed, property
    /// binding/converter errors, etc.) and that isn't already caught
    /// closer to its source lands here instead of the .NET default of
    /// silently killing the process. e.Handled = true keeps the app
    /// running — a wrong/stale screen is recoverable; a dead process
    /// mid-shift is not.
    /// </summary>
    private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        AppFileLog.LogException("DispatcherUnhandledException", e.Exception);

        MessageBox.Show(
            "Vaccine Assist ran into a problem and had to recover from it. " +
            "The details were saved to a log file (%AppData%\\VaccineAssist\\logs\\app.log) — " +
            "use the Data entry popup's \"Copy logs\" button to grab recent lines if this keeps happening.\n\n" +
            $"{e.Exception.GetType().Name}: {e.Exception.Message}",
            "Vaccine Assist",
            MessageBoxButton.OK,
            MessageBoxImage.Warning);

        e.Handled = true;
    }

    /// <summary>
    /// Backstop for exceptions on a thread other than the UI thread (e.g.
    /// raw ThreadPool work not marshaled back through the Dispatcher).
    /// The CLR does not allow this to be "handled" — if IsTerminating is
    /// true the process is going down regardless — but logging it first
    /// means a crash of this kind still leaves a trace instead of nothing
    /// at all.
    /// </summary>
    private void OnAppDomainUnhandledException(object sender, UnhandledExceptionEventArgs e)
    {
        if (e.ExceptionObject is Exception ex)
        {
            AppFileLog.LogException("AppDomainUnhandledException" + (e.IsTerminating ? " (terminating)" : ""), ex);
        }
        else
        {
            AppFileLog.Log($"[AppDomainUnhandledException] non-Exception payload: {e.ExceptionObject}");
        }
    }

    /// <summary>
    /// Backstop for a faulted Task that nobody ever awaited or observed —
    /// e.g. ShowLoginWindow's `_ = loginViewModel.TryAutoSignInAsync();`
    /// fire-and-forget call. Modern .NET no longer crashes the process
    /// for this by default (unlike .NET Framework), so this handler is
    /// purely for visibility: without it, a fault here would just vanish
    /// silently once the GC collected the Task.
    /// </summary>
    private void OnUnobservedTaskException(object? sender, UnobservedTaskExceptionEventArgs e)
    {
        AppFileLog.LogException("UnobservedTaskException", e.Exception);
        e.SetObserved();
    }
}
