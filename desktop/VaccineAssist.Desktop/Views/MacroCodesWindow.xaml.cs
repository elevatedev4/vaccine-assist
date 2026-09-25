using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Navigation;
using FlaUI.Core.WindowsAPI;
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
///
/// 2026-09-25 (age-macro flow, Will's brief): also reused, unchanged, by
/// MainWindow.ShowAgeMacroPrompt — that flow shows an AgePromptWindow
/// first, then opens THIS SAME window class at an age-filtered URL (see
/// the overrideUrl constructor parameter and AgeMacroCodesUrlBuilder) so
/// the copy path is identical either way. The only behavioral difference
/// is sendCtrlNumPad5OnClose: when true, CoreWebView2_OnWebMessageReceived's
/// existing copy-then-Close is followed, after this window has actually
/// closed and focus is back on the previous foreground window, by a
/// synthetic Ctrl+NumPad5 keypress (see MacroCodesWindow_OnClosed) —
/// originally briefed as "pushes Ctrl+Keypad 2, which will activate our
/// on-computer macro," then re-keyed same-day (Will, verbatim, round 2):
/// "it runs the macro at the end with ctrl + keypad 5" — the hotkey that
/// opens this flow moved to Ctrl+Keypad 2 itself (see MainWindow's
/// _ageMacroHotKey), so the closing keypress moved to Ctrl+Keypad 5 to
/// avoid colliding with it. The plain Ctrl+Keypad 8 popup
/// (sendCtrlNumPad5OnClose: false, the default) behaves exactly as before.
/// </summary>
public partial class MacroCodesWindow : Window
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    private readonly string _macroCodesUrl;
    private readonly IClipboardService _clipboardService;
    private readonly IntPtr _previousForegroundWindow;
    private readonly bool _sendCtrlNumPad5OnClose;

    /// <summary>
    /// MACRO-POPUP ROUND 3: this window's own non-WebView chrome height
    /// (title bar + borders — see MacroCodesWindowSizing's doc comment
    /// for why there's nothing else to measure here), captured once in
    /// MacroCodesWindow_OnLoaded as `ActualHeight - WebView.ActualHeight`
    /// rather than hard-coded, so it stays correct across Windows
    /// versions/DPI/theme instead of guessing a constant. Added to every
    /// content-size-driven resize in ApplyContentSize below.
    /// </summary>
    private double _chromeHeight;

    /// <summary>Set true only inside CoreWebView2_OnWebMessageReceived's
    /// "vaccine-assist:macro-copied" case, and only when
    /// _sendCtrlNumPad5OnClose is true — i.e. a code actually got copied
    /// in the age-macro flow. MacroCodesWindow_OnClosed checks THIS field
    /// (not _sendCtrlNumPad5OnClose directly) before sending the
    /// synthetic Ctrl+NumPad5, so cancelling (Escape, the page's own
    /// "vaccine-assist:macro-cancel", or the window chrome) never fires
    /// the on-computer macro against a clipboard that was never actually
    /// updated by this window.</summary>
    private bool _codeCopiedInAgeMacroFlow;

    /// <param name="cloudApiBaseUrl">AppSettings.CloudApiBaseUrl, e.g. https://vaccine-assist.vercel.app — same base URL VaccineApiService calls against. Ignored (but still required) when <paramref name="overrideUrl"/> is given.</param>
    /// <param name="clipboardService">Same IClipboardService the rest of the app uses (App.xaml.cs's composition root) — belt-and-braces clipboard copy alongside the page's own copy (see CoreWebView2_OnWebMessageReceived).</param>
    /// <param name="previousForegroundWindow">The foreground window handle at the moment MainWindow decided to show this popup (captured via GetForegroundWindow() before Show() — for the age-macro flow, before AgePromptWindow, per Will's brief) — restored via SetForegroundWindow when this popup closes, so focus lands back where the pharmacist was, not on this app's MainWindow. IntPtr.Zero is tolerated (just skips the restore) rather than throwing.</param>
    /// <param name="overrideUrl">2026-09-25: the age-macro flow's own AgeMacroCodesUrlBuilder.BuildUrl result (…/macro-codes?embed=1&amp;age=&lt;years&gt;) in place of the plain BuildMacroCodesUrl(cloudApiBaseUrl) below. Null (the default) keeps the existing Ctrl+Keypad 8 behavior unchanged.</param>
    /// <param name="sendCtrlNumPad5OnClose">2026-09-25 round 2: true only for the age-macro flow (see the class doc comment above) — sends a synthetic Ctrl+NumPad5 once this window has closed and focus is restored. False (the default) for the plain Ctrl+Keypad 8 popup.</param>
    public MacroCodesWindow(
        string cloudApiBaseUrl,
        IClipboardService clipboardService,
        IntPtr previousForegroundWindow,
        string? overrideUrl = null,
        bool sendCtrlNumPad5OnClose = false)
    {
        InitializeComponent();
        _clipboardService = clipboardService ?? throw new ArgumentNullException(nameof(clipboardService));
        _previousForegroundWindow = previousForegroundWindow;
        _macroCodesUrl = overrideUrl ?? BuildMacroCodesUrl(cloudApiBaseUrl);
        _sendCtrlNumPad5OnClose = sendCtrlNumPad5OnClose;

        // MACRO-POPUP ROUND 3 (Will, verbatim, 2026-09-25): "Make it
        // wider... and make the height fit only what it needs..." Width
        // is now as wide as the work area allows (up to 1700px — see
        // MacroCodesWindowSizing.ComputeWidth); Height starts modest
        // (InitialHeight) rather than a large fixed guess, so the window
        // doesn't flash tall then shrink once the page's first
        // "vaccine-assist:content-size" message arrives and
        // CoreWebView2_OnWebMessageReceived resizes it for real (see
        // ApplyContentSize below) — both are still applied here, before
        // Show/ShowDialog, so WindowStartupLocation="CenterScreen" centers
        // against these values on first show.
        Width = MacroCodesWindowSizing.ComputeWidth(SystemParameters.WorkArea.Width);
        Height = Math.Min(MacroCodesWindowSizing.InitialHeight, SystemParameters.WorkArea.Height - MacroCodesWindowSizing.WorkAreaMarginPx);

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
        // MACRO-POPUP ROUND 3: captured here (before the WebView2 init
        // below, while WebView is still guaranteed visible/laid-out —
        // see ShowInitFailure) rather than hard-coded, so ApplyContentSize
        // can add back exactly this window's own title-bar/border height
        // regardless of Windows version/DPI/theme. WebView fills the root
        // Grid (no other sizing element competes with it), so this
        // difference IS the window's non-content chrome.
        _chromeHeight = Math.Max(0, ActualHeight - WebView.ActualHeight);

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
                        if (_sendCtrlNumPad5OnClose)
                        {
                            _codeCopiedInAgeMacroFlow = true;
                            AppFileLog.Log($"[AgeMacro] copied {code}");
                        }
                    }
                    Close();
                    break;

                case "vaccine-assist:macro-cancel":
                    Close();
                    break;

                // MACRO-POPUP ROUND 3 (Will's verbatim ask, 2026-09-25):
                // the page reports its own rendered size — see
                // lib/macro-embed.ts's ContentSizeMessage — after first
                // paint and on every subsequent layout change; this
                // resizes the window to match instead of guessing a fixed
                // size up front.
                case "vaccine-assist:content-size":
                    if (message.RootElement.TryGetProperty("height", out var heightElement) &&
                        heightElement.TryGetDouble(out var contentHeight))
                    {
                        ApplyContentSize(contentHeight);
                    }
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

    /// <summary>
    /// MACRO-POPUP ROUND 3: resizes this window to fit `contentHeightPx`
    /// (the page's own document.documentElement.scrollHeight, CSS px ==
    /// WPF DIPs here — see ContentSizeMessage's doc comment) plus this
    /// window's own measured chrome, clamped to the work area
    /// (MacroCodesWindowSizing.ComputeHeight), then re-centers the window
    /// — CenterScreen only applies on the very first Show, and every
    /// resize after that needs this done by hand since ResizeMode is
    /// NoResize (nothing else ever moves/resizes this window). Width
    /// itself never changes here — only Height/Left/Top — since the
    /// brief's width fix is a one-time "as wide as the work area allows"
    /// applied once in the constructor, not something that reacts to
    /// content.
    /// </summary>
    private void ApplyContentSize(double contentHeightPx)
    {
        Dispatcher.Invoke(() =>
        {
            var workArea = SystemParameters.WorkArea;
            var newHeight = MacroCodesWindowSizing.ComputeHeight(contentHeightPx, _chromeHeight, workArea.Height);
            Height = newHeight;
            var (left, top) = MacroCodesWindowSizing.ComputeCenteredPosition(
                Width, newHeight, workArea.Left, workArea.Top, workArea.Width, workArea.Height);
            Left = left;
            Top = top;
            AppFileLog.Log($"[MacroCodes] sized {Width}x{Height} from content {contentHeightPx}");
        });
    }

    /// <summary>Brief step 3: "on ... the window's own Escape (PreviewKeyDown) just close." Handled at the window level (not inside the WebView2 page) so it works even before/if the page never loads (e.g. the failure panel is showing).</summary>
    private void MacroCodesWindow_OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape)
        {
            Close();
        }
    }

    /// <summary>Restores foreground focus to whatever was active before this popup was shown (see the constructor's doc comment) — runs regardless of how the popup was closed (code copied, cancelled, Escape, or the window chrome). Also detaches the WebMessageReceived handler and disposes the WebView2 control so its CoreWebView2 environment/process is released promptly rather than waiting on GC.
    ///
    /// 2026-09-25 (age-macro flow only, and only when _codeCopiedInAgeMacroFlow
    /// is true — see that field's doc comment for why a cancel/Escape close
    /// never reaches this branch): after focus is restored, waits ~150ms
    /// (async void + await Task.Delay,
    /// same "don't block the UI thread" pattern as MacroCodesWindow_OnLoaded's
    /// async WebView2 init above — SendInput itself is an OS-level call
    /// that works regardless of thread, so the delay is the only reason
    /// this needs to be async) so the previous foreground app has actually
    /// finished becoming the foreground window before the synthetic
    /// keypress lands, then sends Ctrl+NumPad5 via FlaUI's
    /// Keyboard.TypeSimultaneously — the same SendInput-backed helper
    /// PioneerEntryAutomation's steps already use for other key
    /// combinations (e.g. SendF3AndDismissPreEntryDialogsStep's Alt+Down/
    /// Alt+O), rather than a second hand-rolled SendInput wrapper.
    ///
    /// Originally briefed (and shipped internally, same day) as Ctrl+
    /// NumPad2 — deliberately NOT one of this app's own registered global
    /// hotkeys at the time (that combination was moved to Ctrl+NumPad7
    /// back in MSG893 specifically because it collided with something
    /// else on the pharmacy's workstations), so sending it couldn't be
    /// swallowed by this app's own WndProc hook. Round 2, same day (Will,
    /// verbatim): "it runs the macro at the end with ctrl + keypad 5" —
    /// changed to Ctrl+NumPad5 because the hotkey that OPENS this flow
    /// moved to Ctrl+NumPad2 itself (see GlobalHotKey.VK_NUMPAD2's doc
    /// comment and MainWindow's _ageMacroHotKey), so sending Ctrl+NumPad2
    /// here would now collide with this app's own WndProc hook for that
    /// hotkey. VirtualKeyShort.NUMPAD5 confirmed present in FlaUI.Core
    /// 4.0.0 the same way NUMPAD2 was confirmed for the original
    /// brief.</summary>
    private async void MacroCodesWindow_OnClosed(object? sender, EventArgs e)
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

        if (!_codeCopiedInAgeMacroFlow)
        {
            return;
        }

        AppFileLog.Log("[AgeMacro] focus restored");

        try
        {
            await Task.Delay(150);
            // Fully-qualified: System.Windows.Input.Keyboard (already used
            // in this file for Key/KeyEventArgs' namespace) and
            // FlaUI.Core.Input.Keyboard share the bare name "Keyboard" —
            // a `using FlaUI.Core.Input;` here would be an ambiguous-
            // reference compile error, so this calls it fully-qualified
            // instead rather than adding that using.
            FlaUI.Core.Input.Keyboard.TypeSimultaneously(new[] { VirtualKeyShort.LCONTROL, VirtualKeyShort.NUMPAD5 });
            AppFileLog.Log("[AgeMacro] sent Ctrl+Num5");
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("MacroCodesWindow.SendCtrlNumPad5", ex);
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
