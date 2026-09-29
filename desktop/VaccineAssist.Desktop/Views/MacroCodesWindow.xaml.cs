using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Navigation;
using System.Windows.Threading;
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

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, [MarshalAs(UnmanagedType.Bool)] bool fAttach);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr SetActiveWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AllowSetForegroundWindow(uint dwProcessId);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    /// <summary>ASFW_ANY — see DataEntryPopupWindow.ActivateAndFocusCurrentStage's doc comment for the full rationale behind this whole P/Invoke sequence, duplicated here rather than shared to keep this popup-focus fix scoped to this file.</summary>
    private const uint ASFW_ANY = 0xFFFFFFFF;

    private const byte VK_MENU = 0x12;

    private const uint KEYEVENTF_KEYUP = 0x0002;

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

    /// <summary>REVIEWER FIX (REQUEST_CHANGES, 2026-09-28): "Focus-after-
    /// Dispose race, no guard." ScheduleFocusWebView/FocusWebView are
    /// called from four places (right after Show(), CoreWebView2 init,
    /// NavigationCompleted, and this window's own Activated — see
    /// ActivateAndFocusWebView's doc comment), each ending in a
    /// Dispatcher.BeginInvoke(DispatcherPriority.Input, ...) call.
    /// MacroCodesWindow_OnClosed disposes WebView synchronously but never
    /// cancelled an already-queued focus operation — since
    /// DispatcherPriority.Input (5) is lower than Normal (9), a focus
    /// call queued by NavigationCompleted or an Activated re-fire from
    /// the Topmost toggle would routinely run AFTER Dispose() on every
    /// ordinary close (copy-a-code, Escape-cancel, age-macro auto-close),
    /// and a post-Dispose WebView.Focus() call reaching
    /// App.OnDispatcherUnhandledException pops the "ran into a problem"
    /// MessageBox on completely normal use. Set true at the very top of
    /// MacroCodesWindow_OnClosed, before anything else runs — both
    /// ScheduleFocusWebView and FocusWebView bail out immediately once
    /// this is true.</summary>
    private bool _closed;

    /// <summary>ESCAPE FIX (Will, 2026-09-28, verbatim): "pushing Esc
    /// closes the whole app window [while a dose is armed]. Instead, make
    /// it clear back to the full list ... then esc again closes the app
    /// window." True once CoreWebView2_OnNavigationCompleted has fired
    /// with e.IsSuccess (the page's own Escape/hotkey listener is
    /// guaranteed wired up at that point — see
    /// cloud/app/macro-codes/page.tsx's hotkeys effect); false before
    /// that and reset to false on a failed navigation, so a page that
    /// never loaded (FailurePanel showing) can't leave the popup stuck
    /// with no way to close it. See MacroCodesEscapePolicy for the actual
    /// decision this guards.</summary>
    private bool _pageReady;

    /// <summary>REVIEWER FIX: the pending Dispatcher.BeginInvoke operation
    /// from ScheduleFocusWebView's DispatcherPriority.Input call (there's
    /// at most one meaningfully in flight at a time — each call re-uses
    /// this field rather than tracking a list), so MacroCodesWindow_OnClosed
    /// can Abort() it directly instead of relying on the _closed guard
    /// alone. Null whenever nothing is currently queued/pending.</summary>
    private DispatcherOperation? _pendingFocusOperation;

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

        // FOCUS FIX (Will, 2026-09-28, 1:14pm): the popup appeared but
        // didn't have keyboard focus, so pressing a hotkey letter (F for
        // Flucelvax) did nothing until the pharmacist clicked into it
        // first — see ActivateAndFocusWebView's doc comment for the full
        // fix. Activated is wired the same "belt-and-suspenders" way
        // DataEntryPopupWindow_OnActivated is: ActivateAndFocusWebView
        // already schedules a focus attempt itself, but re-scheduling
        // here too costs nothing (focusing the same control again is a
        // no-op) and covers any future path that activates this window
        // without going through that method.
        Activated += MacroCodesWindow_OnActivated;
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
    /// data-entry popup. Now just delegates to ActivateAndFocusWebView so
    /// a repeat hotkey press re-focuses the WebView (and its hotkey
    /// listener) the same way the very first Show does — see that
    /// method's doc comment for why the plain Activate()+SetForegroundWindow
    /// this used to do on its own wasn't reliable enough (FOCUS FIX,
    /// Will, 2026-09-28).
    /// </summary>
    public void BringToFront()
    {
        ActivateAndFocusWebView();
    }

    /// <summary>
    /// FOCUS FIX (Will, 2026-09-28, 1:14pm, verbatim symptom): "the macro-
    /// codes popup appears but does NOT have keyboard focus. Pressing F
    /// ... does nothing until he clicks inside the popup." Both spawn
    /// paths that show this window (MainWindow.ShowMacroCodesPopup for
    /// the plain Ctrl+Keypad 8 popup, and ShowAgeMacroPrompt for the
    /// age-macro flow) call this right after Show(), and BringToFront
    /// above (the "already open, re-activate" path) delegates to it too.
    ///
    /// This window is opened from a global hotkey while PioneerRx (or
    /// whatever the pharmacist was using) is the foreground window — same
    /// "Windows refuses to let a background process steal foreground/
    /// keyboard focus" problem DataEntryPopupWindow.ActivateAndFocusCurrentStage
    /// solves for the data-entry popup, and the same fix: Activate() (WPF's
    /// own request) is not enough on its own, so this runs the same
    /// multi-fallback Win32 sequence (AllowSetForegroundWindow(ASFW_ANY),
    /// then an AttachThreadInput-backed SetForegroundWindow, then an "Alt
    /// nudge" retry if that still didn't take, then a Topmost toggle to
    /// force WPF to reassert activation) before focusing this window's
    /// WebView2 control specifically — the earlier BringToFront never
    /// focused the WebView at all, which is why the window came to the
    /// foreground but keystrokes still didn't reach the page's document
    /// keydown listener (cloud/app/macro-codes/page.tsx).
    ///
    /// Focus is placed on the WebView control (not just the window) at
    /// FOUR points, because the page can finish rendering at any of them
    /// relative to this call: here (deferred to Loaded if the window
    /// hasn't laid out yet), again once CoreWebView2 finishes
    /// initializing (MacroCodesWindow_OnLoaded), again once the page's
    /// own navigation completes (CoreWebView2_OnNavigationCompleted —
    /// the page may still be loading when this window first becomes
    /// active), and again from this window's own Activated event
    /// (MacroCodesWindow_OnActivated) as a final belt-and-suspenders
    /// catch-all. Re-focusing the same control repeatedly is a no-op.
    /// </summary>
    public void ActivateAndFocusWebView()
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
        if (handle == IntPtr.Zero)
        {
            AppFileLog.Log("[Focus] MacroCodesWindow.ActivateAndFocusWebView: no native handle yet after Activate() — skipping the rest of the foreground sequence.");
            ScheduleFocusWebView();
            return;
        }

        AppFileLog.Log($"[Focus] MacroCodesWindow: After Activate(): GetForegroundWindow()==hwnd is {IsThisWindowForeground(handle)}.");

        // Best-effort throughout, same posture as
        // DataEntryPopupWindow.ActivateAndFocusCurrentStage: every Win32
        // call here no-ops on failure rather than throwing, and the
        // sequence keeps going regardless.
        AllowSetForegroundWindow(ASFW_ANY);

        TryAttachedSetForeground(handle);
        AppFileLog.Log($"[Focus] MacroCodesWindow: After attach-thread-input SetForegroundWindow/SetActiveWindow: GetForegroundWindow()==hwnd is {IsThisWindowForeground(handle)}.");

        if (!IsThisWindowForeground(handle))
        {
            TryAltNudgeThenSetForeground(handle);
            AppFileLog.Log($"[Focus] MacroCodesWindow: After the Alt-nudge fallback: GetForegroundWindow()==hwnd is {IsThisWindowForeground(handle)}.");
        }

        Topmost = false;
        Topmost = true;

        ScheduleFocusWebView();
    }

    private static bool IsThisWindowForeground(IntPtr handle) => GetForegroundWindow() == handle;

    /// <summary>Same AttachThreadInput-backed fallback as
    /// DataEntryPopupWindow.TryAttachedSetForeground — see that method's
    /// doc comment. Always pairs the attach with a detach in finally.</summary>
    private void TryAttachedSetForeground(IntPtr handle)
    {
        var foreground = GetForegroundWindow();
        if (foreground == handle)
        {
            SetActiveWindow(handle);
            return;
        }

        var foregroundThreadId = foreground == IntPtr.Zero ? 0u : GetWindowThreadProcessId(foreground, out _);
        var currentThreadId = GetCurrentThreadId();
        var attached = false;
        try
        {
            if (foregroundThreadId != 0 && foregroundThreadId != currentThreadId)
            {
                attached = AttachThreadInput(currentThreadId, foregroundThreadId, true);
            }

            BringWindowToTop(handle);
            SetForegroundWindow(handle);
            SetActiveWindow(handle);
        }
        finally
        {
            if (attached)
            {
                AttachThreadInput(currentThreadId, foregroundThreadId, false);
            }
        }
    }

    /// <summary>Same synthetic-Alt-keypress fallback as
    /// DataEntryPopupWindow.TryAltNudgeThenSetForeground — see that
    /// method's doc comment for why this helps SetForegroundWindow
    /// succeed. Key DOWN then UP so Alt is never left logically stuck.</summary>
    private static void TryAltNudgeThenSetForeground(IntPtr handle)
    {
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        SetForegroundWindow(handle);
        SetActiveWindow(handle);
    }

    /// <summary>Defers FocusWebView to DispatcherPriority.Input (WPF can't
    /// reliably accept a focus request before the window has actually
    /// finished becoming active — same reasoning as
    /// DataEntryPopupWindow.ScheduleFocusCurrentStagePrimaryControl), or
    /// to this window's Loaded event if it hasn't fired yet (Show() does
    /// not always raise Loaded synchronously before returning).
    ///
    /// REVIEWER FIX (REQUEST_CHANGES, 2026-09-28): bails out immediately
    /// once _closed is set (see that field's doc comment) instead of
    /// queuing a focus call that could run after WebView.Dispose(). The
    /// queued Dispatcher operation itself is captured into
    /// _pendingFocusOperation so MacroCodesWindow_OnClosed can Abort() it
    /// directly too — belt-and-suspenders alongside the _closed check
    /// inside FocusWebView, in case an operation was already dequeued and
    /// mid-flight when Close() ran.</summary>
    private void ScheduleFocusWebView()
    {
        if (_closed) return;

        if (!IsLoaded)
        {
            Loaded -= MacroCodesWindow_OnLoadedFocusRetry;
            Loaded += MacroCodesWindow_OnLoadedFocusRetry;
            return;
        }

        _pendingFocusOperation = Dispatcher.BeginInvoke(DispatcherPriority.Input, new Action(FocusWebView));
    }

    private void MacroCodesWindow_OnLoadedFocusRetry(object sender, RoutedEventArgs e)
    {
        Loaded -= MacroCodesWindow_OnLoadedFocusRetry;
        if (_closed) return;
        _pendingFocusOperation = Dispatcher.BeginInvoke(DispatcherPriority.Input, new Action(FocusWebView));
    }

    /// <summary>Puts WPF/keyboard focus directly on the WebView2 control
    /// so the embedded page (not this window's own chrome) receives
    /// keydown events immediately — see ActivateAndFocusWebView's doc
    /// comment for why this is called from multiple points. Safe to call
    /// before CoreWebView2 has finished initializing; WebView.Focus() is
    /// a plain WPF focus call on the control itself.
    ///
    /// REVIEWER FIX (REQUEST_CHANGES, 2026-09-28): a _closed re-check
    /// right before touching WebView, PLUS a try/catch around the calls
    /// themselves — ScheduleFocusWebView's _closed guard and
    /// MacroCodesWindow_OnClosed's Abort() cover the common case, but a
    /// Dispatcher operation can already be mid-flight (dequeued, about to
    /// run this method) the instant Close() starts running on the same
    /// thread, so neither of those alone fully closes the race. If
    /// WebView.Focus()/Keyboard.Focus() still throws on an already-
    /// disposed WebView2 control (ObjectDisposedException/
    /// InvalidOperationException — WebView2's own Dispose() contract
    /// doesn't guarantee which one), this swallows it rather than letting
    /// it reach App.OnDispatcherUnhandledException, which would otherwise
    /// pop the "Vaccine Assist ran into a problem" MessageBox on
    /// completely ordinary popup use (copy-a-code, Escape-cancel,
    /// age-macro auto-close).</summary>
    private void FocusWebView()
    {
        if (_closed) return;

        try
        {
            WebView.Focus();
            Keyboard.Focus(WebView);
        }
        catch (ObjectDisposedException)
        {
            // Lost the race against Close()/Dispose() — nothing to focus
            // anymore, nothing to log; this is the expected shape of the
            // race this guard exists for, not a real failure.
        }
        catch (InvalidOperationException)
        {
            // Same race, different exception shape (observed from
            // WebView2/WPF depending on exactly how far Dispose() had
            // gotten) — same "nothing to do" response.
        }
    }

    /// <summary>Belt-and-suspenders catch-all — see
    /// ActivateAndFocusWebView's doc comment. Mirrors
    /// DataEntryPopupWindow_OnActivated.</summary>
    private void MacroCodesWindow_OnActivated(object? sender, EventArgs e)
    {
        ScheduleFocusWebView();
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
            WebView.CoreWebView2.NavigationCompleted += CoreWebView2_OnNavigationCompleted;
            WebView.CoreWebView2.Navigate(_macroCodesUrl);

            // FOCUS FIX (Will, 2026-09-28): CoreWebView2 init can finish
            // after the window has already been activated/focused above
            // (ActivateAndFocusWebView runs synchronously off the hotkey
            // callback; this await can still be pending at that point) —
            // re-focus now that the control is actually ready to receive
            // it. See ActivateAndFocusWebView's doc comment.
            ScheduleFocusWebView();
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("MacroCodesWindow.WebView2Init", ex);
            ShowInitFailure(ex);
        }
    }

    private void ShowInitFailure(Exception ex)
    {
        // ESCAPE FIX: WebView2 itself never came up, so there's no page
        // to hand Escape to — keep closing the window directly.
        _pageReady = false;

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
    /// FOCUS FIX (Will, 2026-09-28): the page may still be mid-navigation
    /// when ActivateAndFocusWebView first ran (see its doc comment for
    /// why focus is placed from several points), so this re-focuses the
    /// WebView once the page has actually finished loading — the point
    /// at which its own document keydown listener
    /// (cloud/app/macro-codes/page.tsx) is guaranteed to be wired up.
    /// Also nudges the embedded document itself via window.focus() —
    /// belt-and-suspenders on top of the WPF-level WebView.Focus()/
    /// Keyboard.Focus() FocusWebView already does; best-effort, so any
    /// failure is logged and swallowed rather than surfaced.
    /// </summary>
    private void CoreWebView2_OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        // ESCAPE FIX: only a successful navigation means the page's own
        // Escape/hotkey listener is actually wired up — see _pageReady's
        // doc comment and MacroCodesEscapePolicy. A failed navigation
        // (e.g. transient network issue) leaves this false so Escape
        // keeps closing the window directly instead of relying on a page
        // that never finished loading.
        _pageReady = e.IsSuccess;

        ScheduleFocusWebView();

        _ = TryFocusDocumentAsync();
    }

    private async Task TryFocusDocumentAsync()
    {
        try
        {
            if (WebView.CoreWebView2 is not null)
            {
                await WebView.CoreWebView2.ExecuteScriptAsync("window.focus();");
            }
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("MacroCodesWindow.WindowFocusScript", ex);
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

    /// <summary>ESCAPE FIX (Will, 2026-09-28, verbatim): "pushing Esc
    /// closes the whole app window [while a dose is armed]. Instead, make
    /// it clear back to the full list of macro codes, then esc again
    /// closes the app window." Originally this closed on every Escape
    /// unconditionally (brief step 3 from the original build: "on ... the
    /// window's own Escape (PreviewKeyDown) just close") — that fires
    /// before the embedded page's own document keydown listener ever sees
    /// the key, so the page's already-correct "first Escape clears the
    /// armed dose, second Escape posts macro-cancel" logic
    /// (cloud/lib/macro-hotkeys.ts hotkeyTransition +
    /// app/macro-codes/page.tsx) never got a chance to run.
    ///
    /// Now: let the page own Escape whenever it safely can (see
    /// MacroCodesEscapePolicy's doc comment for what "safely can" means)
    /// by doing nothing and leaving the event unhandled, so it continues
    /// to the WebView2 control's document. The page will either clear the
    /// armed state (first Escape) or post
    /// "vaccine-assist:macro-cancel" (second Escape), which
    /// CoreWebView2_OnWebMessageReceived already closes the window for.
    /// Only fall back to closing here directly when the page can't be
    /// trusted to have handled it (not loaded yet, or navigation failed)
    /// — the pharmacist must never be stuck with a popup no key can
    /// dismiss.
    ///
    /// V-T64 FIX (Will, 2026-09-29, verbatim): "Escape is still closing
    /// the full window, not backing out of Shingrix." The policy used to
    /// also require WebView.IsKeyboardFocusWithin here — see
    /// MacroCodesEscapePolicy's doc comment for why that flag is an
    /// unreliable proxy for whether the page will actually receive this
    /// keystroke (WPF's own keyboard-focus bookkeeping for the WebView2
    /// HwndHost, not the browser's real/native focus state) and was
    /// exactly what caused this window to close itself out from under an
    /// armed dose even while the pharmacist was actively using the page.
    /// Once the page has loaded, it is the sole owner of Escape.</summary>
    private void MacroCodesWindow_OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Escape)
        {
            return;
        }

        if (MacroCodesEscapePolicy.ShouldCloseImmediately(_pageReady))
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
        // REVIEWER FIX (REQUEST_CHANGES, 2026-09-28): set FIRST, before
        // anything else below — see _closed's own doc comment. Every
        // focus entry point (ScheduleFocusWebView, the Loaded retry
        // handler, FocusWebView itself) checks this and bails out, so
        // nothing queued or newly triggered after this line can reach
        // WebView post-Dispose. Abort() on the still-pending operation
        // (if any) is belt-and-suspenders on top of that — cancels a
        // call that's already sitting in the Dispatcher queue outright
        // rather than letting it run and rely on FocusWebView's own
        // _closed/try-catch guards.
        _closed = true;
        _pendingFocusOperation?.Abort();
        _pendingFocusOperation = null;

        Activated -= MacroCodesWindow_OnActivated;
        Loaded -= MacroCodesWindow_OnLoadedFocusRetry;

        if (WebView.CoreWebView2 is not null)
        {
            WebView.CoreWebView2.WebMessageReceived -= CoreWebView2_OnWebMessageReceived;
            WebView.CoreWebView2.NavigationCompleted -= CoreWebView2_OnNavigationCompleted;
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
