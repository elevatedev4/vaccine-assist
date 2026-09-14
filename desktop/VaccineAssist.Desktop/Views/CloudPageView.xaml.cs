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
/// the old five-tabs-lazy-load version). It's now built and initialized
/// EARLIER than that — App.xaml.cs's PrepareMainCloudPageViewAsync
/// constructs this BEFORE MainWindow even exists (while the "Signing
/// in…" splash, or the LoginWindow, is still up), calls
/// EnsureInitializedAsync() explicitly, and — if a just-completed sign-in
/// produced tokens — PerformDesktopHandoffAsync() before MainWindow is
/// shown at all, so the embedded page lands on "/" already signed in
/// instead of showing its own separate cloud login form. This instance is
/// then handed into MainWindow's constructor to host as-is; Loaded (which
/// still fires once it's added to MainWindow's visual tree) is a no-op at
/// that point since _initialized is already true.
/// </summary>
public partial class CloudPageView : UserControl
{
    private readonly string _cloudApiBaseUrl;
    private bool _initialized;

    public CloudPageView(string cloudApiBaseUrl)
    {
        InitializeComponent();
        _cloudApiBaseUrl = cloudApiBaseUrl ?? "";
        Loaded += CloudPageView_OnLoaded;
    }

    private string BuildUrl(string relativePath)
        => $"{_cloudApiBaseUrl.TrimEnd('/')}{relativePath}";

    /// <summary>
    /// Loaded can fire more than once for a UserControl (e.g. if it's ever
    /// removed and re-added to the visual tree) — _initialized guards
    /// against re-running EnsureCoreWebView2Async/Navigate on a control
    /// that already has a live WebView2. Also covers the normal case now
    /// (see class doc comment): when App.xaml.cs already called
    /// EnsureInitializedAsync/PerformDesktopHandoffAsync before this
    /// control was ever added to MainWindow's visual tree, this is a
    /// straight no-op — the page is already showing whatever the handoff
    /// (or its "/" fallback) already navigated it to.
    /// </summary>
    private async void CloudPageView_OnLoaded(object sender, RoutedEventArgs e)
    {
        if (_initialized)
        {
            return;
        }

        await EnsureInitializedAsync();
        NavigateToPath("/");
    }

    /// <summary>
    /// Idempotent — safe to call more than once (only the first call does
    /// anything). Never throws: a WebView2 init failure is caught and
    /// shown as this control's own in-place failure panel, same as
    /// before.
    /// </summary>
    public async Task EnsureInitializedAsync()
    {
        if (_initialized)
        {
            return;
        }
        _initialized = true;

        try
        {
            WebView.Visibility = Visibility.Visible;
            FailurePanel.Visibility = Visibility.Collapsed;

            var environment = await SharedCloudWebView2Environment.GetAsync();
            await WebView.EnsureCoreWebView2Async(environment);
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("CloudPageView.WebView2Init", ex);
            ShowInitFailure(ex);
        }
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

    private void ShowInitFailure(Exception ex)
    {
        WebView.Visibility = Visibility.Collapsed;
        FailurePanel.Visibility = Visibility.Visible;
        FailureDetailTextBlock.Text = $"{ex.GetType().Name}: {ex.Message}";
    }

    /// <summary>Lets staff retry without restarting the whole app.</summary>
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
    /// </summary>
    public async Task<bool> PerformDesktopHandoffAsync(string accessToken, string refreshToken, TimeSpan timeout)
    {
        await EnsureInitializedAsync();
        var coreWebView2 = WebView.CoreWebView2;
        if (coreWebView2 is null)
        {
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

            var completionSource = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            navigationCompletedHandler = (_, e) => completionSource.TrySetResult(e.IsSuccess);
            coreWebView2.NavigationCompleted += navigationCompletedHandler;

            try
            {
                coreWebView2.NavigateWithWebResourceRequest(request);

                var timeoutTask = Task.Delay(timeout);
                var completed = await Task.WhenAny(completionSource.Task, timeoutTask);
                if (completed != completionSource.Task)
                {
                    return false; // timed out
                }

                return await completionSource.Task;
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
