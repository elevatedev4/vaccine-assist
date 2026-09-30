using System;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Threading;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Views;

/// <summary>
/// Originally Ctrl+Keypad 4, re-keyed same day to Ctrl+Keypad 2 (Will,
/// 2026-09-25) — see AgePromptWindow.xaml's doc comment for the full
/// brief/shell rationale and the re-key. Same "static
/// ShowAndGetResult, modal ShowDialog, Result property" convention as
/// TextEntryPromptWindow/VarUpdateConfirmationWindow.
///
/// FOCUS FIX (V-T41 R6, Will, 2026-09-30, verbatim symptom): "The patient
/// age field always needs to be focused when it opens. It's only working
/// about half the time right now. Somehow the focus is remaining in
/// Pioneer." Plain YearsTextBox.Focus()/Keyboard.Focus() from Loaded
/// (what this window used to do) loses the exact same foreground-lock
/// race DataEntryPopupWindow.ActivateAndFocusCurrentStage and
/// MacroCodesWindow.ActivateAndFocusWebView were already fixed for —
/// this window is shown from MainWindow.ShowAgeMacroPrompt while Pioneer
/// (a maximized third-party Win32 app) is still the foreground window.
/// Reuses that SAME Activate()/AllowSetForegroundWindow/AttachThreadInput/
/// Alt-nudge/Topmost-toggle sequence (P/Invokes duplicated locally here
/// rather than shared, matching MacroCodesWindow's own "keep this
/// popup-focus fix scoped to this file" convention), but ALSO layers a
/// DispatcherTimer retry loop on top (Will's brief, verbatim: "may need
/// to refocus after a delayed amount of milliseconds but before the user
/// input starts") — the existing two windows only ever ran this sequence
/// ONCE per activation; that isn't enough here, since this prompt is
/// modal (ShowDialog) and reached straight off a global hotkey with no
/// button click/mouse activity of its own to fall back on if the very
/// first attempt loses the race. See FocusRetrySchedule for the pure,
/// unit-tested delay schedule (50ms, 150ms, 400ms, 800ms, each measured
/// from the previous attempt) and ActivateAndFocusAgeBox for the retry
/// loop itself. Every attempt logs its outcome via AppFileLog — attempt
/// number, whether GetForegroundWindow() matched this window's handle,
/// and whether Keyboard.FocusedElement ended up on YearsTextBox — NEVER
/// the age value itself (this window holds no other patient data to
/// begin with).
/// </summary>
public partial class AgePromptWindow : Window
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

    /// <summary>Set true once (and only once) in AgePromptWindow_OnClosed,
    /// before anything else runs there. Every retry-timer Tick checks this
    /// first and bails out immediately — this window is modal (ShowDialog
    /// pumps its own nested Dispatcher loop), so a retry already queued via
    /// DispatcherTimer can otherwise fire AFTER the user has pressed
    /// Enter/OK/Cancel/Escape and the window has closed, which would touch
    /// a disposed YearsTextBox. Same "_closed guard" convention as
    /// MacroCodesWindow._closed.</summary>
    private bool _closed;

    private readonly DispatcherTimer _focusRetryTimer = new();

    /// <summary>1-based; the immediate attempt made synchronously from
    /// AgePromptWindow_OnLoaded is attempt 1, so this starts at 1 and is
    /// incremented once per FocusRetryTimer_OnTick before that attempt's
    /// own log line.</summary>
    private int _focusAttemptNumber = 1;

    public AgePromptWindow()
    {
        InitializeComponent();
        Closed += AgePromptWindow_OnClosed;
        _focusRetryTimer.Tick += FocusRetryTimer_OnTick;
    }

    public AgePromptResult Result { get; private set; } = AgePromptResult.Cancelled;

    private void AgePromptWindow_OnLoaded(object sender, RoutedEventArgs e)
    {
        ActivateAndFocusAgeBox();
    }

    /// <summary>
    /// Runs the full foreground-stealing + focus sequence once (same
    /// steps, same order, as DataEntryPopupWindow.ActivateAndFocusCurrentStage/
    /// MacroCodesWindow.ActivateAndFocusWebView — see this class's own doc
    /// comment for why THIS window also needs the DispatcherTimer retry
    /// wrapped around it), logs the outcome, and — unless both
    /// GetForegroundWindow() and Keyboard.FocusedElement are already
    /// confirmed on this window/YearsTextBox — arms _focusRetryTimer for
    /// the next delay in FocusRetrySchedule.Delays. Called once
    /// synchronously from Loaded (attempt 1) and once per
    /// FocusRetryTimer_OnTick after that (attempts 2-5).
    /// </summary>
    private void ActivateAndFocusAgeBox()
    {
        if (_closed) return;

        Activate();

        var handle = new WindowInteropHelper(this).Handle;
        if (handle == IntPtr.Zero)
        {
            AppFileLog.Log($"[Focus] AgePromptWindow attempt {_focusAttemptNumber}: no native handle yet after Activate() — will retry.");
            ArmNextRetry();
            return;
        }

        // Best-effort throughout, same posture as
        // DataEntryPopupWindow.ActivateAndFocusCurrentStage: every Win32
        // call here no-ops on failure rather than throwing, and the
        // sequence keeps going regardless.
        AllowSetForegroundWindow(ASFW_ANY);

        TryAttachedSetForeground(handle);

        if (!IsThisWindowForeground(handle))
        {
            TryAltNudgeThenSetForeground(handle);
        }

        Topmost = false;
        Topmost = true;

        // REVIEWER NOTE (V-T41 R6 round 2, confirmed): if the user has
        // ALREADY clicked/tabbed into YearsTextBox and started typing by
        // the time a later retry tick runs this method again, these two
        // calls are a no-op for caret position/selection — WPF's
        // TextBox.Focus()/Keyboard.Focus() only affect IsFocused/
        // FocusedElement state on a control that's already focused; they
        // never reset CaretIndex or clear/change SelectionStart/
        // SelectionLength as a side effect. A late tick can re-assert
        // foreground/focus without disturbing digits the user already
        // typed or where their cursor is.
        YearsTextBox.Focus();
        Keyboard.Focus(YearsTextBox);

        var foregroundMatched = IsThisWindowForeground(handle);
        var focusedElement = Keyboard.FocusedElement;
        var focusMatched = ReferenceEquals(focusedElement, YearsTextBox);

        AppFileLog.Log(
            $"[Focus] AgePromptWindow attempt {_focusAttemptNumber}: " +
            $"GetForegroundWindow()==hwnd is {foregroundMatched}, " +
            $"Keyboard.FocusedElement==YearsTextBox is {focusMatched} " +
            $"(focused element type: {focusedElement?.GetType().Name ?? "none"}).");

        if (foregroundMatched && focusMatched)
        {
            AppFileLog.Log($"[Focus] AgePromptWindow: confirmed on attempt {_focusAttemptNumber}.");
            _focusRetryTimer.Stop();
            return;
        }

        ArmNextRetry();
    }

    /// <summary>Schedules the next FocusRetryTimer_OnTick per
    /// FocusRetrySchedule.Delays (50ms, 150ms, 400ms, 800ms — see that
    /// class's doc comment), or logs that the schedule is exhausted and
    /// gives up once every delay has been used. _focusAttemptNumber tracks
    /// how many of the (1 immediate + 4 retry) attempts have run so far —
    /// index into Delays is _focusAttemptNumber - 1 (attempt 1 already ran
    /// above, so the FIRST retry uses Delays[0]).</summary>
    private void ArmNextRetry()
    {
        if (_closed) return;

        var delayIndex = _focusAttemptNumber - 1;
        if (delayIndex >= FocusRetrySchedule.Delays.Count)
        {
            AppFileLog.Log($"[Focus] AgePromptWindow: retry schedule exhausted after {_focusAttemptNumber} attempts, still not confirmed.");
            return;
        }

        _focusRetryTimer.Stop();
        _focusRetryTimer.Interval = FocusRetrySchedule.Delays[delayIndex];
        _focusRetryTimer.Start();
    }

    private void FocusRetryTimer_OnTick(object? sender, EventArgs e)
    {
        _focusRetryTimer.Stop();
        if (_closed) return;

        _focusAttemptNumber++;
        ActivateAndFocusAgeBox();
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

    /// <summary>Digits only — same "don't let the user type something
    /// that can't be a valid age" posture as the OK button's
    /// AgePromptInput-gated enabled state below.</summary>
    private void AgeTextBox_OnPreviewTextInput(object sender, TextCompositionEventArgs e)
    {
        e.Handled = !e.Text.All(char.IsDigit);
    }

    private void AgeTextBox_OnTextChanged(object sender, TextChangedEventArgs e)
    {
        OkButton.IsEnabled = AgePromptInput.TryParse(YearsTextBox.Text, out _);
    }

    /// <summary>Enter in either textbox is the fast path to OK — same
    /// convention as DataEntryPopupWindow's AgeTextBox_OnKeyDown/
    /// TextEntryPromptWindow's ValueTextBox_OnKeyDown.</summary>
    private void AgeTextBox_OnKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            TryContinue();
        }
    }

    private void OkButton_OnClick(object sender, RoutedEventArgs e) => TryContinue();

    /// <summary>Refuses to return Continued with an age AgePromptInput
    /// doesn't accept — the OK button is disabled in that state already
    /// (see AgeTextBox_OnTextChanged), but Enter can still reach here, so
    /// this re-checks rather than trusting the button's enabled state.</summary>
    private void TryContinue()
    {
        if (!AgePromptInput.TryParse(YearsTextBox.Text, out var years))
        {
            return;
        }

        Result = AgePromptResult.Continued(years);
        DialogResult = true;
    }

    private void CancelButton_OnClick(object sender, RoutedEventArgs e)
    {
        Result = AgePromptResult.Cancelled;
        DialogResult = false;
    }

    /// <summary>Same "the window's own Escape just closes/cancels" rule
    /// as MacroCodesWindow_OnPreviewKeyDown.</summary>
    private void AgePromptWindow_OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape)
        {
            Result = AgePromptResult.Cancelled;
            DialogResult = false;
        }
    }

    /// <summary>See _closed's own doc comment. Stops/abandons any pending
    /// retry timer so FocusRetryTimer_OnTick can never touch this window's
    /// controls after it's gone.</summary>
    private void AgePromptWindow_OnClosed(object? sender, EventArgs e)
    {
        _closed = true;
        _focusRetryTimer.Stop();
    }

    /// <summary>Shows the dialog modally (no Owner — see the xaml's doc
    /// comment) and returns the outcome.</summary>
    public static AgePromptResult ShowAndGetResult()
    {
        var window = new AgePromptWindow();
        window.ShowDialog();
        return window.Result;
    }
}
