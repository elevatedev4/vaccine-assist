using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Navigation;
using Microsoft.Web.WebView2.Core;
using VaccineAssist.Desktop.Logging;
using VaccineAssist.Desktop.Services;

namespace VaccineAssist.Desktop.Views;

/// <summary>
/// The Ctrl+8 macro-codes popup (Will, 2026-09-13). Non-modal (Show, not
/// ShowDialog) same as DataEntryPopupWindow — Topmost keeps it above
/// PioneerRx without blocking the rest of the app. Hosts the cloud app's
/// /macro-codes?embed=1 page in a WebView2 control; see
/// MacroCodesWindow.xaml's doc comment for the full contract with that
/// page.
///
/// MainWindow owns at most one instance at a time (same "re-activate,
/// don't stack" rule as _openDataEntryPopup) and passes in the foreground
/// window handle captured right before this popup was shown, so it can be
/// restored on close — the pharmacist should land back in whatever they
/// were doing (typically PioneerRx) the moment a code is copied, per
/// Will's brief: "closes the page so they can go resume data entry
/// themselves."
/// </summary>
public partial class MacroCodesWindow : Window
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    private readonly string _macroCodesUrl;
    private readonly IClipboardService _clipboardService;
    private readonly IntPtr _previousForegroundWindow;

    /// <param name="cloudApiBaseUrl">AppSettings.CloudApiBaseUrl, e.g. https://vaccine-assist.vercel.app — same base URL VaccineApiService calls against.</param>
    /// <param name="clipboardService">Same IClipboardService the rest of the app uses (App.xaml.cs's composition root) — belt-and-braces clipboard copy alongside the page's own copy (see CoreWebView2_OnWebMessageReceived).</param>
    /// <param name="previousForegroundWindow">The foreground window handle at the moment MainWindow decided to show this popup (captured via GetForegroundWindow() before Show()) — restored via SetForegroundWindow when this popup closes, so focus lands back where the pharmacist was, not on this app's MainWindow. IntPtr.Zero is tolerated (just skips the restore) rather than throwing.</param>
    public MacroCodesWindow(string cloudApiBaseUrl, IClipboardService clipboardService, IntPtr previousForegroundWindow)
    {
        InitializeComponent();
        _clipboardService = clipboardService ?? throw new ArgumentNullException(nameof(clipboardService));
        _previousForegroundWindow = previousForegroundWindow;
        _macroCodesUrl = BuildMacroCodesUrl(cloudApiBaseUrl);

        Loaded += MacroCodesWindow_OnLoaded;
        Closed += MacroCodesWindow_OnClosed;
    }

    private static string BuildMacroCodesUrl(string cloudApiBaseUrl)
    {
        var baseUrl = (cloudApiBaseUrl ?? "").TrimEnd('/');
        return $"{baseUrl}/macro-codes?embed=1";
    }

    /// <summary>
    /// MainWindow.ShowMacroCodesPopup calls this instead of opening a
    /// second popup when the hotkey fires while one is already showing —
    /// same "bring the existing instance forward" rule
    /// DataEntryPopupWindow.ActivateAndFocusCurrentStage follows for the
    /// data-entry popup, just without that method's fuller multi-fallback
    /// dance (AttachThreadInput/Alt-nudge): this popup is triggered from
    /// the SAME hotkey-press dispatcher callback that grants foreground-
    /// activation rights (see GlobalHotKey.WndProc), so a direct
    /// SetForegroundWindow call here is expected to succeed without those
    /// extra fallbacks.
    /// </summary>
    public void BringToFront()
    {
        if (Visibility != Visibility.Visible)
        {
            Show();
        }
        if (WindowState == WindowState.Minimized)
        {
            WindowState = WindowState.Normal;
        }

        Activate();

        var handle = new WindowInteropHelper(this).Handle;
        if (handle != IntPtr.Zero)
        {
            SetForegroundWindow(handle);
        }

        Topmost = false;
        Topmost = true;
    }

    /// <summary>
    /// Step 4 of the brief: WebView2 init failures (most commonly, the
    /// Evergreen WebView2 Runtime isn't installed on this workstation) are
    /// caught here and shown as a one-line in-window message with a
    /// download link — never left to crash the app or the process-wide
    /// DispatcherUnhandledException backstop in App.xaml.cs.
    /// </summary>
    private async void MacroCodesWindow_OnLoaded(object sender, RoutedEventArgs e)
    {
        try
        {
            // Shared across every WebView2 surface in the app (this popup
            // AND the cloud-parity tabs — see
            // Services/SharedCloudWebView2Environment.cs) so a session
            // signed into on any one of them is signed in everywhere else
            // too. Same %LocalAppData%\VaccineAssist\webview2 user-data
            // folder as before this change — the brief: "the page shows
            // its normal sign-in if the WebView has no session (session
            // persists in the WebView2 user-data folder afterwards)".
            var environment = await SharedCloudWebView2Environment.GetAsync();
            await WebView.EnsureCoreWebView2Async(environment);

            WebView.CoreWebView2.WebMessageReceived += CoreWebView2_OnWebMessageReceived;
            WebView.CoreWebView2.Navigate(_macroCodesUrl);
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("MacroCodesWindow.WebView2Init", ex);
            ShowInitFailure(ex);
        }
    }

    private void ShowInitFailure(Exception ex)
    {
        WebView.Visibility = Visibility.Collapsed;
        FailurePanel.Visibility = Visibility.Visible;
        FailureDetailTextBlock.Text = $"{ex.GetType().Name}: {ex.Message}";
    }

    /// <summary>
    /// The contract with the cloud page (see MacroCodesWindow.xaml's doc
    /// comment): a click on a dose posts
    /// { type: "vaccine-assist:macro-copied", code, label, product } —
    /// the page has already copied `code` to the clipboard itself, so this
    /// is belt-and-braces (setting it again here is harmless/idempotent),
    /// per the brief. Escape inside the page (or any other reason the page
    /// wants to back out) posts { type: "vaccine-assist:macro-cancel" } —
    /// same close, no clipboard action. Any other/malformed message is
    /// logged and otherwise ignored rather than throwing.
    /// </summary>
    private void CoreWebView2_OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var message = JsonDocument.Parse(e.WebMessageAsJson);
            var type = message.RootElement.TryGetProperty("type", out var typeElement)
                ? typeElement.GetString()
                : null;

            switch (type)
            {
                case "vaccine-assist:macro-copied":
                    if (message.RootElement.TryGetProperty("code", out var codeElement) &&
                        codeElement.GetString() is { Length: > 0 } code)
                    {
                        _clipboardService.SetText(code);
                    }
                    Close();
                    break;

                case "vaccine-assist:macro-cancel":
                    Close();
                    break;

                default:
                    AppFileLog.Log($"[MacroCodesWindow] Ignored unrecognized web message type: {type ?? "(none)"}");
                    break;
            }
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("MacroCodesWindow.WebMessageReceived", ex);
        }
    }

    /// <summary>Brief step 3: "on ... the window's own Escape (PreviewKeyDown) just close." Handled at the window level (not inside the WebView2 page) so it works even before/if the page never loads (e.g. the failure panel is showing).</summary>
    private void MacroCodesWindow_OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape)
        {
            Close();
        }
    }

    /// <summary>Restores foreground focus to whatever was active before this popup was shown (see the constructor's doc comment) — runs regardless of how the popup was closed (code copied, cancelled, Escape, or the window chrome). Also detaches the WebMessageReceived handler and disposes the WebView2 control so its CoreWebView2 environment/process is released promptly rather than waiting on GC.</summary>
    private void MacroCodesWindow_OnClosed(object? sender, EventArgs e)
    {
        if (WebView.CoreWebView2 is not null)
        {
            WebView.CoreWebView2.WebMessageReceived -= CoreWebView2_OnWebMessageReceived;
        }
        WebView.Dispose();

        if (_previousForegroundWindow != IntPtr.Zero)
        {
            SetForegroundWindow(_previousForegroundWindow);
        }
    }

    /// <summary>WPF's Hyperlink doesn't launch a browser on its own — this opens the Evergreen WebView2 Runtime download link in the user's default browser via the shell, same as clicking any other external link would.</summary>
    private void DownloadLink_OnRequestNavigate(object sender, RequestNavigateEventArgs e)
    {
        try
        {
            Process.Start(new ProcessStartInfo(e.Uri.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("MacroCodesWindow.OpenDownloadLink", ex);
        }
        e.Handled = true;
    }
}
