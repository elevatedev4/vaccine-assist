using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;

namespace VaccineAssist.Desktop.Overlay;

/// <summary>
/// The "Vaccine entry in progress…" panel — see the XAML's doc comment
/// for the full picture. PioneerOverlayController owns this window's
/// lifetime/positioning (immediately left of the blue Pioneer overlay
/// icon); this class only knows about "show a step name" and "raise one
/// event when the X is clicked," mirroring PioneerOverlayWindow's own
/// thin click -> event contract.
/// </summary>
public sealed partial class EntryStatusOverlayWindow : Window
{
    // Same WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW mechanism as
    // Overlay/PioneerOverlayWindow.xaml.cs — duplicated here rather than
    // shared, matching this codebase's existing convention of duplicating
    // this small P/Invoke block per overlay window file (see e.g.
    // MacroCodesWindow.xaml.cs's own ASFW_ANY doc comment on the same
    // choice).
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_NOACTIVATE = 0x08000000;
    private const int WS_EX_TOOLWINDOW = 0x00000080;

    [DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    /// <summary>Raised when the X is clicked — PioneerOverlayController
    /// forwards this to MainWindow, which cancels the active Ctrl+Keypad 7
    /// run's CancellationTokenSource.</summary>
    public event EventHandler? CancelRequested;

    /// <summary>Raw HWND for PioneerOverlayController's SetWindowPos calls — IntPtr.Zero until SourceInitialized has run.</summary>
    public IntPtr Handle { get; private set; } = IntPtr.Zero;

    public EntryStatusOverlayWindow()
    {
        InitializeComponent();
        SourceInitialized += OnSourceInitialized;
    }

    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        Handle = new WindowInteropHelper(this).Handle;
        var exStyle = GetWindowLong(Handle, GWL_EXSTYLE);
        SetWindowLong(Handle, GWL_EXSTYLE, exStyle | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW);
    }

    /// <summary>Updates the small second line ("Entering quantity", etc.)
    /// — best-effort, never throws (mirrors every other UI-update helper
    /// in this codebase); called from PioneerOverlayController.Tick every
    /// ~250ms while a run is active, so a step transition shows up quickly
    /// without needing its own separate dispatch.</summary>
    public void SetStepText(string stepText)
    {
        try
        {
            StepTextBlock.Text = stepText;
        }
        catch
        {
            // best-effort — see doc comment above.
        }
    }

    private void CancelBorder_OnClick(object sender, MouseButtonEventArgs e)
    {
        CancelRequested?.Invoke(this, EventArgs.Empty);
    }
}
