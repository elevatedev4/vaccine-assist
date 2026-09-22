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
/// Pioneer is minimized, or the "Show Pioneer overlay" setting is off.
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
    }

    private void Tick()
    {
        try
        {
            if (!_settings.ShowPioneerOverlay)
            {
                HideIfShown();
                _loggedFailure = false;
                return;
            }

            if (!PioneerMainWindowLocator.TryGetMainWindow(out var bounds, out var isMinimized) || isMinimized)
            {
                HideIfShown();
                _loggedFailure = false;
                return;
            }

            var window = EnsureWindow();
            var scale = NativeOverlayPositioning.DpiScaleFor(window.Handle);
            var rect = OverlayPlacement.Compute(bounds, scale);
            NativeOverlayPositioning.Reposition(window.Handle, rect.X, rect.Y, rect.Width, rect.Height, show: true);
            _shown = true;
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
    }
}
