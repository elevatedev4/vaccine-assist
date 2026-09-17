using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Navigation;
using Microsoft.Web.WebView2.Core;
using VaccineAssist.Desktop.Logging;
using VaccineAssist.Desktop.Services;

namespace VaccineAssist.Desktop.Views;

/// <summary>
/// Hosts the cloud app inside the desktop app. Single-nav change (Will,
/// 2026-09-14: "all the tabs in the app [should] match exactly what is in
/// the cloud" / "remove that extra row of tabs"): MainWindow now hosts
/// exactly ONE instance of this control, full-window, loading the cloud
/// root ("/") — the cloud app's OWN top nav (Schedule/Ordering/Data
/// Entry/Screener/Lots/Macro codes/Entry values/Settings — see
/// cloud/lib/nav-config.ts) is the only tab row now; the desktop no
/// longer draws a second one. MainWindow.NavigateTo (the tray menu/
/// overlay's cloud-route items) drives this same instance's WebView2
/// rather than swapping in a new control per tab.
///
/// LIFECYCLE CHANGE (V-T-desktop-handoff, Part 1): this control used to
/// take a target relativePath at construction time and always navigate to
/// it the first time it loaded into a visual tree (see git history for
/// the old five-tabs-lazy-load version). App.xaml.cs's
/// ShowMainWindowAndInitializeAsync now drives its whole init+handoff
/// lifecycle explicitly instead: it constructs this control with
/// autoInitializeOnLoad: false (so Loaded is a no-op — see that field's
/// doc comment), hands it straight into MainWindow's constructor, Shows()
/// MainWindow, and ONLY THEN calls EnsureInitializedAsync() and — if a
/// just-completed sign-in produced tokens — PerformDesktopHandoffAsync(),
/// so the embedded page lands on "/" already signed in instead of showing
/// its own separate cloud login form.
///
/// ORDERING FIX (Will's app.log, 2026-09-16): this control's WebView2
/// can't create its CoreWebView2Controller until it has a parent HWND,
/// which only exists once the hosting window (MainWindow) has actually
/// been Show()n — so the init call above must come AFTER MainWindow.Show(),
/// never before. The old order (this control initialized before MainWindow
/// even existed) meant EnsureCoreWebView2Async could never finish before
/// EnsureInitializedAsync's own timeout — see App.xaml.cs's
/// ShowMainWindowAndInitializeAsync for the full diagnosis. MainWindow
/// itself is kept out of view (ShowActivated: false, behind whichever
/// "Signing in…" window is already up) for the brief window between Show()
/// and the handoff finishing, so there's no visible blank/unauthenticated
/// flash even though this control is now added to a visual tree well
/// before it's actually ready.
/// </summary>
public partial class CloudPageView : UserControl
{
    private readonly string _cloudApiBaseUrl;

    /// <summary>True once an init attempt has run and resolved — on
    /// success, on a real exception, OR on a timeout (NOT the same as "the
    /// WebView2 is actually ready"; see <see cref="IsCoreWebView2Ready"/>
    /// for that). Guards against automatic callers (Loaded,
    /// PerformDesktopHandoffAsync, ClearBrowsingDataAsync) re-waiting on an
    /// already-resolved attempt. Only RetryButton_OnClick clears it.</summary>
    private bool _initialized;

    /// <summary>The actual (possibly still in-flight) init call. Kept
    /// across a timeout so Retry — and the timeout's own late-completion
    /// observer — both watch the SAME attempt instead of a second one ever
    /// calling EnsureCoreWebView2Async concurrently on this control (WebView2
    /// does not support that). Only replaced once the previous attempt
    /// actually faulted outright (not just timed out).</summary>
    private Task? _initTask;

    /// <summary>Guards against attaching more than one late-completion
    /// continuation to the same <see cref="_initTask"/> (e.g. if Retry
    /// itself also times out while reusing it) — harmless either way, just
    /// avoids duplicate log lines.</summary>
    private bool _lateCompletionObserved;

    /// <summary>
    /// Fires once, on the UI thread, if a WebView2 init that had already
    /// been reported as a timeout later completes successfully on its own
    /// (see ObserveLateInitCompletion) — by the time this fires, the
    /// failure panel is already hidden and the WebView is already showing
    /// "/". App.xaml.cs's InitializeAndHandoffCloudPageViewAsync subscribes
    /// to this so a slow-but-eventually-successful start can still redo the
    /// desktop sign-in handoff instead of leaving the embedded page on its
    /// own separate login form.
    /// </summary>
    public event EventHandler? InitializedLate;

    /// <summary>False for the single MainWindow-hosted instance
    /// App.xaml.cs's ShowMainWindowAndInitializeAsync constructs — that
    /// flow drives EnsureInitializedAsync/NavigateToPath itself, in a
    /// specific order (init, then a token handoff, BEFORE any "/"
    /// navigation happens) so the embedded page never flashes its own
    /// unauthenticated login form before the handoff lands. Leaving
    /// Loaded's default auto-init+navigate-to-"/" behavior on here would
    /// race that: Loaded fires as soon as this control enters MainWindow's
    /// visual tree, i.e. as soon as MainWindow.Show() is called — which is
    /// exactly when App.xaml.cs's own explicit EnsureInitializedAsync call
    /// is ABOUT to run, not after it — and EnsureInitializedAsync's
    /// _initialized guard means only the FIRST caller's await actually
    /// waits for the init to finish; a second, redundant call just returns
    /// immediately. True (the default) for any other caller that simply
    /// drops a CloudPageView into a visual tree and expects it to load "/"
    /// on its own with no external orchestration.</summary>
    private readonly bool _autoInitializeOnLoad;

    public CloudPageView(string cloudApiBaseUrl, bool autoInitializeOnLoad = true)
    {
        InitializeComponent();
        _cloudApiBaseUrl = cloudApiBaseUrl ?? "";
        _autoInitializeOnLoad = autoInitializeOnLoad;
        Loaded += CloudPageView_OnLoaded;
    }

    /// <summary>True only once WebView.EnsureCoreWebView2Async has actually
    /// succeeded — unlike <see cref="_initialized"/>, this is false the
    /// whole time a timed-out attempt is still (silently) running in the
    /// background. App.xaml.cs uses this right after EnsureInitializedAsync
    /// to decide whether to attempt the desktop sign-in handoff now, or
    /// wait for <see cref="InitializedLate"/> instead.</summary>
    public bool IsCoreWebView2Ready => WebView.CoreWebView2 is not null;

    private string BuildUrl(string relativePath)
        => $"{_cloudApiBaseUrl.TrimEnd('/')}{relativePath}";

    /// <summary>
    /// Loaded can fire more than once for a UserControl (e.g. if it's ever
    /// removed and re-added to the visual tree) — _initialized guards
    /// against re-running EnsureCoreWebView2Async/Navigate on a control
    /// that already has a live WebView2. Also a straight no-op whenever
    /// _autoInitializeOnLoad is false (see that field's doc comment) — the
    /// normal case now for MainWindow's single instance, since
    /// App.xaml.cs's ShowMainWindowAndInitializeAsync is fully responsible
    /// for calling EnsureInitializedAsync/PerformDesktopHandoffAsync/
    /// NavigateToPath itself, in that specific order, AFTER this control
    /// has already loaded into MainWindow's visual tree.
    /// </summary>
    private async void CloudPageView_OnLoaded(object sender, RoutedEventArgs e)
    {
        if (_initialized || !_autoInitializeOnLoad)
        {
            return;
        }

        await EnsureInitializedAsync();
        NavigateToPath("/");
    }

    /// <summary>
    /// Idempotent — safe to call more than once; automatic callers
    /// (Loaded, PerformDesktopHandoffAsync, ClearBrowsingDataAsync)
    /// short-circuit once an attempt has resolved (see
    /// <see cref="_initialized"/>'s doc comment) — only RetryButton_OnClick
    /// clears that flag to force another wait. Never throws: a WebView2
    /// init failure is caught and shown as this control's own in-place
    /// failure panel, same as before.
    ///
    /// TIMEOUT FIX (Will, 2026-09-16 — "I just tried to sign in and it's
    /// just not doing anything"): neither SharedCloudWebView2Environment.
    /// GetAsync() nor EnsureCoreWebView2Async() had a timeout at all before
    /// this. Vercel's logs for the failed sign-in showed ZERO hits on
    /// /api/auth/desktop-handoff — not a rejected/errored handoff, no
    /// handoff request reached the server at all — which only fits this
    /// step hanging before PerformDesktopHandoffAsync's own NavigateWithWebResourceRequest
    /// ever ran. A hang here used to be silent and permanent: nothing else
    /// in the call chain (App.xaml.cs's init+handoff orchestration/
    /// PerformDesktopHandoffAsync) had a way to notice, so the Login/splash
    /// window just sat there forever. Capped at InitWaitPolicy.Timeout,
    /// after which this behaves exactly like any other init failure (the
    /// existing failure panel + Retry button) instead of hanging — see
    /// LoginViewModel.SetBusy's doc comment for the other half of this fix
    /// (why the button/spinner ALSO looked idle during this hang).
    ///
    /// TIMEOUT RAISED (Will, 2026-09-16 — same-day follow-up: a slow but
    /// otherwise healthy WebView2 Evergreen start on Will's own PC took
    /// longer than the original 12s cap, especially right after a rebuild
    /// with a cold %LocalAppData%\VaccineAssist\webview2 user-data folder,
    /// so a slow-but-successful start was being shown as a hard failure).
    /// The cap moves to InitWaitPolicy.Timeout (45s); past
    /// InitWaitPolicy.HintDelay (3s) an in-place "Starting the embedded
    /// browser…" status shows so the wait doesn't look like a frozen page.
    /// If the timeout still fires, the abandoned attempt is NOT cancelled
    /// (WebView2 has no CancellationToken here) — ObserveLateInitCompletion
    /// keeps watching it, and <see cref="InitializedLate"/> fires if it
    /// eventually succeeds anyway (see that method and App.xaml.cs's
    /// InitializeAndHandoffCloudPageViewAsync).
    /// </summary>
    public async Task EnsureInitializedAsync()
    {
        if (_initialized)
        {
            return;
        }
        _initialized = true;

        // Reuse a still-in-flight attempt (Retry after a timeout, or a
        // second caller racing the first) instead of ever calling
        // EnsureCoreWebView2Async a second time on this control — WebView2
        // does not support that. A previous attempt that faulted outright
        // (a real exception, not a timeout) gets a genuinely fresh attempt.
        var initTask = _initTask;
        if (initTask is null || initTask.IsFaulted)
        {
            initTask = _initTask = InitializeWebView2Async();
            _lateCompletionObserved = false;
        }

        try
        {
            WebView.Visibility = Visibility.Visible;
            FailurePanel.Visibility = Visibility.Collapsed;
            InitStatusTextBlock.Visibility = Visibility.Collapsed;

            var hintDelayTask = Task.Delay(InitWaitPolicy.HintDelay);
            var timeoutTask = Task.Delay(InitWaitPolicy.Timeout);

            var completed = await Task.WhenAny(initTask, hintDelayTask, timeoutTask);
            if (completed == hintDelayTask)
            {
                InitStatusTextBlock.Visibility = Visibility.Visible;
                completed = await Task.WhenAny(initTask, timeoutTask);
            }

            if (completed == timeoutTask)
            {
                AppFileLog.Log($"[CloudPageView] WebView2 init timed out after {InitWaitPolicy.Timeout.TotalSeconds:0}s");
                if (!_lateCompletionObserved)
                {
                    _lateCompletionObserved = true;
                    ObserveLateInitCompletion(initTask);
                }
                ShowInitFailure(new TimeoutException("The embedded browser took too long to start."));
                return;
            }

            await initTask; // propagate a real init exception into the catch below
            InitStatusTextBlock.Visibility = Visibility.Collapsed;
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("CloudPageView.WebView2Init", ex);
            ShowInitFailure(ex);
        }
    }

    private async Task InitializeWebView2Async()
    {
        var environment = await SharedCloudWebView2Environment.GetAsync();

        var stopwatch = Stopwatch.StartNew();
        await WebView.EnsureCoreWebView2Async(environment);
        stopwatch.Stop();
        AppFileLog.Log($"[CloudPageView] EnsureCoreWebView2Async completed in {stopwatch.ElapsedMilliseconds}ms");
    }

    /// <summary>Same reasoning as StartupSignInCoordinator.ObserveLateCompletion
    /// and LoginViewModel.ObserveLateCompletion — an abandoned init isn't
    /// cancelled (WebView2's own APIs here take no CancellationToken),
    /// just no longer waited on. Beyond logging the eventual completion
    /// (keeping it from becoming an UnobservedTaskException), a LATE
    /// SUCCESS now also recovers the UI on the dispatcher thread — hides
    /// the failure panel, re-shows the WebView, navigates back to "/", and
    /// raises <see cref="InitializedLate"/> — instead of leaving staff
    /// stuck on the failure panel forever for what turned out to be just a
    /// slow start.</summary>
    private void ObserveLateInitCompletion(Task task)
    {
        _ = task.ContinueWith(
            t =>
            {
                if (t.IsFaulted)
                {
                    var ex = t.Exception?.GetBaseException();
                    AppFileLog.Log($"[CloudPageView] late WebView2 init completion after timeout: faulted ({ex?.GetType().Name}: {ex?.Message})");
                    return;
                }

                if (!t.IsCompletedSuccessfully)
                {
                    return;
                }

                AppFileLog.Log("[CloudPageView] late WebView2 init completion after timeout: succeeded");
                Dispatcher.Invoke(() =>
                {
                    if (FailurePanel.Visibility != Visibility.Visible)
                    {
                        // Already recovered some other way (e.g. an
                        // explicit Retry reused this same task and its own
                        // await already resolved it) — nothing left to do.
                        return;
                    }

                    WebView.Visibility = Visibility.Visible;
                    FailurePanel.Visibility = Visibility.Collapsed;
                    InitStatusTextBlock.Visibility = Visibility.Collapsed;

                    // REVIEW FIX (2026-09-16, non-blocking): if App.xaml.cs
                    // is subscribed, its handler is about to run
                    // PerformDesktopHandoffAsync, which navigates ("/",
                    // signed in) as part of the handoff itself — navigating
                    // here too would just be a visible double-navigation
                    // flash. No subscriber (e.g. MacroCodesWindow never
                    // subscribes to this at all) means nobody else will
                    // navigate, so fall back to a plain "/" load.
                    var lateSubscriber = InitializedLate;
                    if (lateSubscriber is null)
                    {
                        NavigateToPath("/");
                    }
                    lateSubscriber?.Invoke(this, EventArgs.Empty);
                });
            },
            TaskScheduler.Default);
    }

    /// <summary>Navigates the already-initialized WebView2 to a cloud route
    /// (e.g. "/lots") — used by MainWindow.NavigateTo for the tray menu/
    /// overlay's cloud items. A no-op (not a throw) if CoreWebView2 isn't
    /// ready yet, e.g. EnsureInitializedAsync failed.</summary>
    public void NavigateToPath(string relativePath)
    {
        if (WebView.CoreWebView2 is null)
        {
            return;
        }
        WebView.CoreWebView2.Navigate(BuildUrl(relativePath));
    }

    /// <summary>REVIEW FIX (2026-09-16, blocker): also collapses
    /// InitStatusTextBlock — without this, a failure/timeout that lands
    /// here after the 3s hint was already shown left "Starting the
    /// embedded browser…" rendered on top of FailurePanel (both live in
    /// the same Grid).</summary>
    private void ShowInitFailure(Exception ex)
    {
        WebView.Visibility = Visibility.Collapsed;
        InitStatusTextBlock.Visibility = Visibility.Collapsed;
        FailurePanel.Visibility = Visibility.Visible;
        FailureDetailTextBlock.Text = $"{ex.GetType().Name}: {ex.Message}";
    }

    /// <summary>Lets staff retry without restarting the whole app.
    /// RETRY-WHILE-IN-FLIGHT FIX (Will, 2026-09-16): if the prior attempt
    /// only timed out (rather than faulting outright), EnsureInitializedAsync
    /// reuses that same still-running _initTask instead of starting a
    /// second, concurrent EnsureCoreWebView2Async call on this control —
    /// only the timeout/hint window actually restarts.</summary>
    private async void RetryButton_OnClick(object sender, RoutedEventArgs e)
    {
        _initialized = false; // let EnsureInitializedAsync actually re-run
        await EnsureInitializedAsync();
        NavigateToPath("/");
    }

    /// <summary>
    /// Part 1 (Will's brief): POSTs the desktop's current Supabase
    /// access/refresh tokens to the cloud's
    /// /api/auth/desktop-handoff route via
    /// CoreWebView2.NavigateWithWebResourceRequest, so the WebView2 signs
    /// itself in the same way an interactive browser sign-in would rather
    /// than showing its own separate cloud login form. That route
    /// validates the tokens server-side and 303-redirects to "/" with a
    /// short-lived cookie a client-side bootstrap on that page reads to
    /// call the cloud's own supabase-js browser client's
    /// auth.setSession(...) — see the route's own doc comment
    /// (cloud/app/api/auth/desktop-handoff/route.ts) for why a cookie
    /// hand-off is used at all in an app whose real sessions live in
    /// localStorage. Chromium/WebView2 follows that 303 as part of the
    /// SAME navigation, so a single NavigationCompleted here covers the
    /// whole round trip, landing on "/" already signed in.
    ///
    /// SECURITY REVIEW FIX (login CSRF, blocker): the request now carries
    /// X-Vaccine-Assist-Desktop: 1 — the route rejects any POST missing
    /// this header (see route.ts's isTrustedDesktopRequest), which is the
    /// whole point: an ordinary web page can POST JSON at this endpoint
    /// via the text/plain-form trick but cannot set a custom header on
    /// that kind of request, so it can never pass this check.
    ///
    /// SECURITY REVIEW FIX (stale embedded session, blocker): clears this
    /// WebView2 profile's site data BEFORE every handoff attempt (not just
    /// on sign-out — see MainWindow.SignOutAndRaiseLoggedOutAsync for
    /// that half) so a second pharmacist signing in on a shared
    /// workstation never lands inside the previous one's still-cached
    /// localStorage session; see ClearBrowsingDataAsync's own doc comment.
    ///
    /// Caps the wait at <paramref name="timeout"/> (App.xaml.cs passes
    /// 10s) and NEVER throws: a timeout, a non-2xx/network failure, or any
    /// exception all just return false — the caller logs a single
    /// [Startup] line and moves on; the embedded page simply falls back to
    /// showing its own cloud sign-in form, exactly as if this had never
    /// been attempted. Never logs the token values themselves.
    ///
    /// DIAGNOSTIC FIX (Will's brief, 2026-09-16 — late-recovery handoff
    /// visibility): every false return now also logs its own concrete
    /// reason ([CloudPageView] PerformDesktopHandoffAsync: ...) — not
    /// ready/skipped, timed out, or a completed-but-unsuccessful navigation
    /// (WebErrorStatus, plus HttpStatusCode when the installed WebView2
    /// Runtime exposes it) — so the caller's generic "[Startup] ... failed
    /// or timed out" line (used both for the normal and the InitializedLate
    /// late-recovery path) always has a preceding line naming the actual
    /// cause. An outright exception still goes through AppFileLog.LogException
    /// below, which already captures the full type/message/stack chain.
    /// </summary>
    public async Task<bool> PerformDesktopHandoffAsync(string accessToken, string refreshToken, TimeSpan timeout)
    {
        await EnsureInitializedAsync();
        var coreWebView2 = WebView.CoreWebView2;
        if (coreWebView2 is null)
        {
            AppFileLog.Log("[CloudPageView] PerformDesktopHandoffAsync: skipped (CoreWebView2 not ready)");
            return false;
        }

        // Always clear first — see this method's doc comment. Best-effort
        // (never throws, capped separately below); a failure here still
        // lets the handoff itself proceed rather than aborting the whole
        // sign-in flow over a cache-clearing hiccup.
        await ClearBrowsingDataAsync(TimeSpan.FromSeconds(5));

        EventHandler<CoreWebView2NavigationCompletedEventArgs>? navigationCompletedHandler = null;

        try
        {
            var json = JsonSerializer.Serialize(new { access_token = accessToken, refresh_token = refreshToken });
            using var postDataStream = new MemoryStream(Encoding.UTF8.GetBytes(json));

            var request = coreWebView2.Environment.CreateWebResourceRequest(
                BuildUrl("/api/auth/desktop-handoff"),
                "POST",
                postDataStream,
                "Content-Type: application/json\r\nX-Vaccine-Assist-Desktop: 1\r\n");

            CoreWebView2NavigationCompletedEventArgs? completedArgs = null;
            var completionSource = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            navigationCompletedHandler = (_, e) =>
            {
                completedArgs = e;
                completionSource.TrySetResult(e.IsSuccess);
            };
            coreWebView2.NavigationCompleted += navigationCompletedHandler;

            try
            {
                coreWebView2.NavigateWithWebResourceRequest(request);

                var timeoutTask = Task.Delay(timeout);
                var completed = await Task.WhenAny(completionSource.Task, timeoutTask);
                if (completed != completionSource.Task)
                {
                    AppFileLog.Log($"[CloudPageView] PerformDesktopHandoffAsync: timed out after {timeout.TotalSeconds:0}s waiting for the desktop-handoff navigation to complete");
                    return false; // timed out
                }

                var success = await completionSource.Task;
                if (!success)
                {
                    // HttpStatusCode was added to CoreWebView2NavigationCompletedEventArgs
                    // in a later WebView2 Runtime API set than this SDK's
                    // minimum — reading it against an older installed
                    // Evergreen Runtime can throw. Never worth losing the
                    // WebErrorStatus detail (or failing this already-false
                    // result) over that.
                    int? httpStatusCode = null;
                    try
                    {
                        httpStatusCode = completedArgs?.HttpStatusCode;
                    }
                    catch (Exception)
                    {
                        // Older Runtime — WebErrorStatus alone is still logged below.
                    }

                    var webErrorStatusName = completedArgs?.WebErrorStatus.ToString() ?? "unknown";
                    AppFileLog.Log($"[CloudPageView] PerformDesktopHandoffAsync: navigation did not succeed ({DesktopHandoffFailureDescription.Describe(webErrorStatusName, httpStatusCode)})");
                }

                return success;
            }
            finally
            {
                coreWebView2.NavigationCompleted -= navigationCompletedHandler;
            }
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("CloudPageView.PerformDesktopHandoffAsync", ex);
            return false;
        }
    }

    /// <summary>
    /// SECURITY REVIEW FIX (stale embedded session, blocker): the shared
    /// WebView2 profile (%LocalAppData%\VaccineAssist\webview2 — see
    /// Services/SharedCloudWebView2Environment.cs) persists localStorage
    /// across app restarts and across different Windows users on the same
    /// workstation, since it's keyed by folder, not by which pharmacist is
    /// currently signed into the DESKTOP app. Without this, sign-out only
    /// cleared the desktop's own native session (SessionStore/IAuthService)
    /// — the embedded page's OWN supabase-js session in that profile's
    /// localStorage would silently survive, so the NEXT person signing in
    /// on this workstation could land inside the PREVIOUS pharmacist's
    /// cloud account the instant the WebView2 re-showed a cached page.
    ///
    /// Called from two places: MainWindow.SignOutAndRaiseLoggedOutAsync
    /// (BEFORE LoggedOut fires, so the stale session is gone before a new
    /// LoginWindow can start a new one), and PerformDesktopHandoffAsync
    /// (unconditionally, before every handoff attempt — the simplest way
    /// to make "whoever the desktop just signed in as" and "who the
    /// embedded page is signed in as" deterministic, since a silent
    /// 90-day restore never routes through Sign out at all).
    ///
    /// CoreWebView2BrowsingDataKinds.AllSite covers cookies, localStorage,
    /// IndexedDB, cache, etc. for every site in this profile — this
    /// profile is dedicated to this app's own WebView2 surfaces
    /// (CloudPageView + MacroCodesWindow, both pointed at the same cloud
    /// origin), so clearing everything is safe and simplest; there's no
    /// other site's data in this profile to preserve.
    ///
    /// Never throws (a clear failure just means the OLD session might
    /// still be visible — logged, not fatal) and capped at
    /// <paramref name="timeout"/> so a hung clear call can never block
    /// sign-out or the handoff indefinitely.
    /// </summary>
    public async Task ClearBrowsingDataAsync(TimeSpan timeout)
    {
        await EnsureInitializedAsync();
        var profile = WebView.CoreWebView2?.Profile;
        if (profile is null)
        {
            return;
        }

        try
        {
            var clearTask = profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.AllSite);
            var completed = await Task.WhenAny(clearTask, Task.Delay(timeout));
            if (completed != clearTask)
            {
                AppFileLog.Log("[CloudPageView] ClearBrowsingDataAsync timed out — a stale session may still be visible.");
                return;
            }

            await clearTask; // observe/log a faulted task rather than letting it go unobserved
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("CloudPageView.ClearBrowsingDataAsync", ex);
        }
    }

    private void DownloadLink_OnRequestNavigate(object sender, RequestNavigateEventArgs e)
    {
        try
        {
            Process.Start(new ProcessStartInfo(e.Uri.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("CloudPageView.OpenDownloadLink", ex);
        }
        e.Handled = true;
    }
}
