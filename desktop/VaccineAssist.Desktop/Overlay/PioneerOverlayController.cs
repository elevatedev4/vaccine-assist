using System;
using System.Windows.Threading;
using VaccineAssist.Desktop.Logging;
using VaccineAssist.Desktop.Settings;

namespace VaccineAssist.Desktop.Overlay;

/// <summary>
/// Owns the Pioneer overlay icon's whole lifetime (Will's brief, Part 4).
/// MainWindow constructs exactly one instance, calls Start() once
/// MainWindow itself is shown, and Dispose()s it on sign-out/exit — see
/// MainWindow.xaml.cs's own doc comment on why this survives MainWindow
/// being hidden to the tray (same "the tray/hotkeys/popups keep working
/// while hidden" reasoning as everything else in this app's signed-in
/// session).
///
/// A DispatcherTimer ticking every 250ms (same cadence rx-verify's own
/// integrated overlay uses) resolves PioneerRx's main window
/// (PioneerMainWindowLocator), computes where the icon belongs
/// (OverlayPlacement), and repositions/shows/hides it
/// (NativeOverlayPositioning) — hidden whenever no Pioneer window exists,
/// Pioneer is minimized, the "Show Pioneer overlay" setting is off, or
/// (V-T41, Will's 2026-09-29 thread message: "When pioneer is not
/// focused, hide the blue icon, just like we do with RxVerify.")
/// PioneerRx isn't the OS foreground application right now — see
/// PioneerOverlayVisibilityGate.ShouldShow, the pure decision Tick()
/// below feeds.
///
/// Never lets a Tick() failure escape to the Dispatcher (which would hit
/// App.xaml.cs's DispatcherUnhandledException backstop and pop a
/// MessageBox every 250ms) — caught and logged ONCE per failure streak,
/// not on every tick, then simply tries again next tick.
/// </summary>
public sealed class PioneerOverlayController : IDisposable
{
    private readonly Action<string> _navigateTo;
    private readonly Action _showDataEntryPopup;
    private readonly Action _showMacroCodesPopup;
    private readonly Action _exit;
    private readonly AppSettings _settings;
    private readonly DispatcherTimer _timer;

    private PioneerOverlayWindow? _window;
    private bool _shown;
    private bool _loggedFailure;

    /// <summary>V-T41 R5 (Will's brief, item 4) — the "Vaccine entry in
    /// progress…" panel, immediately left of the icon. Lazily created the
    /// first time a run needs it (EnsureEntryStatusWindow), same pattern as
    /// _window/EnsureWindow above.</summary>
    private EntryStatusOverlayWindow? _entryStatusWindow;
    private bool _entryStatusShown;

    /// <summary>True for the whole life of a Ctrl+Keypad 7 run (ShowEntryStatus
    /// .. HideEntryStatus) — Tick() only shows/positions the panel while
    /// this is true, and only when the icon itself would also be shown
    /// (same PioneerOverlayVisibilityGate.ShouldShow result each tick — a
    /// run happening with Pioneer minimized/not foreground hides both
    /// together, consistent with the icon's own visibility rule).</summary>
    private bool _entryStatusActive;
    private string _entryStatusStepText = "";

    /// <summary>Raised when the entry-status panel's X is clicked —
    /// MainWindow cancels the active run's CancellationTokenSource.</summary>
    public event EventHandler? EntryStatusCancelRequested;

    public PioneerOverlayController(
        Action<string> navigateTo,
        Action showDataEntryPopup,
        Action showMacroCodesPopup,
        Action exit,
        AppSettings settings)
    {
        _navigateTo = navigateTo ?? throw new ArgumentNullException(nameof(navigateTo));
        _showDataEntryPopup = showDataEntryPopup ?? throw new ArgumentNullException(nameof(showDataEntryPopup));
        _showMacroCodesPopup = showMacroCodesPopup ?? throw new ArgumentNullException(nameof(showMacroCodesPopup));
        _exit = exit ?? throw new ArgumentNullException(nameof(exit));
        _settings = settings ?? throw new ArgumentNullException(nameof(settings));

        _timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
        _timer.Tick += (_, _) => Tick();
    }

    public void Start() => _timer.Start();

    /// <summary>Stops ticking AND hides the icon immediately — called on sign-out/exit, not just a settings toggle (see HideIfShown for the settings-toggle path, which keeps ticking so it can reappear the moment the setting is flipped back on).</summary>
    public void Stop()
    {
        _timer.Stop();
        HideIfShown();
        HideEntryStatusWindowIfShown();
    }

    /// <summary>V-T41 R5: called once, right before a Ctrl+Keypad 7 run's
    /// first key is sent to Pioneer — MainWindow.RunVaccineEntryAutomationAsync.
    /// Makes the entry-status panel eligible to show on the NEXT tick (it
    /// doesn't force an immediate reposition itself — Tick() already runs
    /// every ~250ms, which is fast enough that the panel appears
    /// effectively immediately).</summary>
    public void ShowEntryStatus(string initialStepText)
    {
        _entryStatusActive = true;
        _entryStatusStepText = initialStepText;
    }

    /// <summary>Updates the panel's step-name line — called once per step
    /// as the run progresses (e.g. "Entering quantity"). A no-op if no run
    /// is currently active (ShowEntryStatus wasn't called, or
    /// HideEntryStatus already was) — the text is still remembered so a
    /// LATE call right at the tail end of Tick's own dispatch ordering
    /// never gets lost.</summary>
    public void UpdateEntryStatusStep(string stepText)
    {
        _entryStatusStepText = stepText;
        _entryStatusWindow?.SetStepText(stepText);
    }

    /// <summary>Ends the run — hides the panel (on the very next tick;
    /// HideIfShown's own immediate-hide posture doesn't apply here since
    /// there's no separate "stop everything now" caller for this one
    /// panel) and clears _entryStatusActive so Tick() stops repositioning
    /// it. Called from a finally block in MainWindow.RunVaccineEntryAutomationAsync
    /// regardless of how the run ended (completed, failed, or halted).</summary>
    public void HideEntryStatus()
    {
        _entryStatusActive = false;
        HideEntryStatusWindowIfShown();
    }

    private void Tick()
    {
        try
        {
            // V-T41 (Will's 2026-09-29 thread message: "When pioneer is
            // not focused, hide the blue icon, just like we do with
            // RxVerify.") — hasMainWindow/isMinimized still drive the
            // icon's POSITION (via bounds below, unchanged, maximized-
            // only per PioneerWindowAnchorRule); isPioneerForegroundApp
            // is the broader, separate "hide unless Pioneer is the app
            // currently in front" signal — see
            // PioneerOverlayVisibilityGate's own doc comment for why
            // that's a different question from which window to anchor
            // to. Both are always gathered so the gate has everything it
            // needs regardless of which condition ends up failing.
            var hasMainWindow = PioneerMainWindowLocator.TryGetMainWindow(out var bounds, out var isMinimized);
            var isPioneerForeground = PioneerMainWindowLocator.IsPioneerForegroundApp();

            if (!PioneerOverlayVisibilityGate.ShouldShow(_settings.ShowPioneerOverlay, hasMainWindow, isMinimized, isPioneerForeground))
            {
                HideIfShown();
                HideEntryStatusWindowIfShown();
                _loggedFailure = false;
                return;
            }

            var window = EnsureWindow();
            var scale = NativeOverlayPositioning.DpiScaleFor(window.Handle);
            var rect = OverlayPlacement.Compute(bounds, scale);
            NativeOverlayPositioning.Reposition(window.Handle, rect.X, rect.Y, rect.Width, rect.Height, show: true);
            _shown = true;

            // V-T41 R5: the entry-status panel tracks the SAME icon rect
            // (immediately left of it) and the SAME visibility gate result
            // above — only its own _entryStatusActive flag decides whether
            // it's shown at all.
            if (_entryStatusActive)
            {
                var statusWindow = EnsureEntryStatusWindow();
                statusWindow.SetStepText(_entryStatusStepText);
                var statusRect = OverlayPlacement.ComputeEntryStatus(rect, scale);
                NativeOverlayPositioning.Reposition(statusWindow.Handle, statusRect.X, statusRect.Y, statusRect.Width, statusRect.Height, show: true);
                _entryStatusShown = true;
            }
            else
            {
                HideEntryStatusWindowIfShown();
            }

            _loggedFailure = false;
        }
        catch (Exception ex)
        {
            if (!_loggedFailure)
            {
                AppFileLog.LogException("PioneerOverlayController.Tick", ex);
                _loggedFailure = true;
            }
        }
    }

    private PioneerOverlayWindow EnsureWindow()
    {
        if (_window is not null)
        {
            return _window;
        }

        var window = new PioneerOverlayWindow();
        window.NavigationRequested += (_, path) => SafeInvoke(() => _navigateTo(path));
        window.DataEntryRequested += (_, _) => SafeInvoke(_showDataEntryPopup);
        window.MacroCodesRequested += (_, _) => SafeInvoke(_showMacroCodesPopup);
        window.ExitRequested += (_, _) => SafeInvoke(_exit);
        // ShowActivated="False" + the WS_EX_NOACTIVATE/WS_EX_TOOLWINDOW
        // styles set in its own OnSourceInitialized mean this never
        // steals focus from PioneerRx.
        window.Show();
        _window = window;
        return window;
    }

    private EntryStatusOverlayWindow EnsureEntryStatusWindow()
    {
        if (_entryStatusWindow is not null)
        {
            return _entryStatusWindow;
        }

        var window = new EntryStatusOverlayWindow();
        window.CancelRequested += (_, _) => SafeInvoke(() => EntryStatusCancelRequested?.Invoke(this, EventArgs.Empty));
        window.Show();
        _entryStatusWindow = window;
        return window;
    }

    private void HideEntryStatusWindowIfShown()
    {
        if (!_entryStatusShown || _entryStatusWindow is null)
        {
            return;
        }
        NativeOverlayPositioning.Reposition(_entryStatusWindow.Handle, 0, 0, 0, 0, show: false);
        _entryStatusShown = false;
    }

    private void HideIfShown()
    {
        if (!_shown || _window is null)
        {
            return;
        }
        NativeOverlayPositioning.Reposition(_window.Handle, 0, 0, 0, 0, show: false);
        _shown = false;
    }

    private static void SafeInvoke(Action action)
    {
        try
        {
            action();
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("PioneerOverlayController.MenuAction", ex);
        }
    }

    public void Dispose()
    {
        Stop();
        _window?.Close();
        _window = null;
        _entryStatusWindow?.Close();
        _entryStatusWindow = null;
    }
}
