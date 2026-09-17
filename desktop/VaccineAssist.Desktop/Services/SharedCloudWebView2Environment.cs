using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// One CoreWebView2Environment shared by every WebView2 control in the
/// app — the Ctrl+Keypad 8 macro-codes popup (MacroCodesWindow) and the
/// cloud-parity tab pages (Views/CloudPageView.xaml.cs) — all pointed at
/// the SAME %LocalAppData%\VaccineAssist\webview2 user-data folder. Will,
/// 2026-09-13 (brief): "sharing ONE WebView2 environment/user-data folder
/// with MacroCodesWindow so login state is shared" — signing in once in
/// any WebView2 surface (the macro popup or any cloud tab) signs in
/// everywhere else too, since they all share the same cookies/
/// localStorage/session storage.
///
/// Cached as a single Task (not re-created per call) because WebView2
/// does not support multiple independent CoreWebView2Environment
/// instances pointed at the same user-data folder running concurrently —
/// every caller must await the SAME environment object.
/// </summary>
public static class SharedCloudWebView2Environment
{
    private static readonly object Lock = new();
    private static Task<CoreWebView2Environment>? _environmentTask;

    /// <summary>
    /// TIMEOUT FIX (Will, 2026-09-16): previously a plain <c>??=</c> — once
    /// CreateAsync() faulted once, every later caller (CloudPageView AND
    /// MacroCodesWindow) got handed back that SAME faulted task forever,
    /// with no way to recover short of restarting the app. Now goes
    /// through FaultTolerantTaskCache so a faulted cached task is dropped
    /// and the next caller gets a fresh attempt instead.
    /// </summary>
    public static Task<CoreWebView2Environment> GetAsync()
    {
        lock (Lock)
        {
            _environmentTask = FaultTolerantTaskCache.GetOrCreate(_environmentTask, CreateAsync);
            return _environmentTask;
        }
    }

    /// <summary>Logs how long the actual CoreWebView2Environment.CreateAsync
    /// call took (or how long it ran before faulting) so the next slow-init
    /// report says where the time actually went — environment creation vs.
    /// EnsureCoreWebView2Async itself (timed separately in
    /// CloudPageView.InitializeWebView2Async).</summary>
    private static async Task<CoreWebView2Environment> CreateAsync()
    {
        var userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "VaccineAssist", "webview2");
        Directory.CreateDirectory(userDataFolder);

        var stopwatch = Stopwatch.StartNew();
        try
        {
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: userDataFolder);
            stopwatch.Stop();
            AppFileLog.Log($"[WebView2] environment created in {stopwatch.ElapsedMilliseconds}ms");
            return environment;
        }
        catch (Exception ex)
        {
            stopwatch.Stop();
            AppFileLog.LogException($"[WebView2] environment creation failed after {stopwatch.ElapsedMilliseconds}ms", ex);
            throw;
        }
    }
}
