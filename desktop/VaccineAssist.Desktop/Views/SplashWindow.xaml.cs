using System;
using System.Windows;
using System.Windows.Input;
using System.Windows.Threading;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Views;

/// <summary>Tiny borderless "Signing in…" placeholder shown during the
/// silent sign-in attempt at startup — see App.xaml.cs's
/// StartSignInFlowAsync and this window's XAML doc comment.
///
/// BUG FIX (Will, 2026-09-14 — "shows the splash floating mid-screen and
/// never moves on; there is no way to close it"): this window used to
/// have no way out at all if the silent attempt hung. It now raises
/// <see cref="CancelRequested"/> from a visible Cancel button or Esc, is
/// draggable (there's no title bar to drag by with WindowStyle="None"),
/// and updates its own status text after 5 seconds purely as a visual
/// cue — none of that closes the window itself; App.xaml.cs owns that
/// decision (it also owns the hard 15s timeout via
/// StartupSignInCoordinator).</summary>
public partial class SplashWindow : Window
{
    private readonly DispatcherTimer _stillSigningInTimer;

    public SplashWindow()
    {
        InitializeComponent();

        _stillSigningInTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
        _stillSigningInTimer.Tick += (_, _) =>
        {
            StatusTextBlock.Text = "Still signing in… (Cancel to sign in manually)";
            _stillSigningInTimer.Stop();
        };
        _stillSigningInTimer.Start();

        Closed += (_, _) => _stillSigningInTimer.Stop();
    }

    /// <summary>Raised by the Cancel button or Esc — App.xaml.cs's
    /// StartSignInFlowAsync subscribes to this and cancels the in-flight
    /// silent sign-in attempt, then shows the manual LoginWindow. Purely a
    /// signal: this window does not close itself or touch any other
    /// window on its own.</summary>
    public event EventHandler? CancelRequested;

    private void Window_OnMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        try
        {
            if (e.ButtonState == MouseButtonState.Pressed)
            {
                DragMove();
            }
        }
        catch (InvalidOperationException ex)
        {
            // DragMove throws if the mouse button was already released by
            // the time this runs, or (irrelevant here — no maximize/
            // restore on a WindowStyle="None" window) the window is
            // maximized. Never worth crashing the startup flow over.
            AppFileLog.LogException("SplashWindow.DragMove", ex);
        }
    }

    private void Window_OnKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape)
        {
            CancelRequested?.Invoke(this, EventArgs.Empty);
        }
    }

    private void CancelButton_OnClick(object sender, RoutedEventArgs e)
    {
        CancelRequested?.Invoke(this, EventArgs.Empty);
    }
}
