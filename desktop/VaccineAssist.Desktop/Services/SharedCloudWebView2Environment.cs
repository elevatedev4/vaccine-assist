using System;
using System.IO;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;

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

    public static Task<CoreWebView2Environment> GetAsync()
    {
        lock (Lock)
        {
            _environmentTask ??= CreateAsync();
            return _environmentTask;
        }
    }

    private static async Task<CoreWebView2Environment> CreateAsync()
    {
        var userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "VaccineAssist", "webview2");
        Directory.CreateDirectory(userDataFolder);

        return await CoreWebView2Environment.CreateAsync(userDataFolder: userDataFolder);
    }
}
