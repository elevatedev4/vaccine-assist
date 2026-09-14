using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using VaccineAssist.Desktop.Navigation;

namespace VaccineAssist.Desktop.Overlay;

/// <summary>
/// The Pioneer overlay icon itself (Will's brief, Part 4) — see the XAML's
/// doc comment for the full picture. PioneerOverlayController owns this
/// window's lifetime and positioning; this class only knows about the
/// click -> menu -> raise-one-event contract, mirroring
/// Tray/TrayIconController's own *Requested event shape so
/// PioneerOverlayController can wire both the same way.
/// </summary>
public sealed partial class PioneerOverlayWindow : Window
{
    // Same WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW mechanism as rx-verify's
    // ControlBoxWindow (overlay/RxVerifyOverlay/Integrated/ControlBoxWindow.xaml.cs) —
    // WS_EX_TOOLWINDOW keeps this out of Alt-Tab (ShowInTaskbar="False"
    // only covers the taskbar itself), WS_EX_NOACTIVATE means Show()/
    // repositioning never steals keyboard focus/activation from
    // PioneerRx.
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_NOACTIVATE = 0x08000000;
    private const int WS_EX_TOOLWINDOW = 0x00000080;

    [DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    /// <summary>Raised with the cloud route to navigate to (e.g. "/lots") when a cloud-route menu item is clicked.</summary>
    public event EventHandler<string>? NavigationRequested;
    public event EventHandler? DataEntryRequested;
    public event EventHandler? MacroCodesRequested;

    /// <summary>Raw HWND for PioneerOverlayController's SetWindowPos calls — IntPtr.Zero until SourceInitialized has run.</summary>
    public IntPtr Handle { get; private set; } = IntPtr.Zero;

    public PioneerOverlayWindow()
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

    /// <summary>
    /// Left-click OR right-click either one pops the same menu (Will's
    /// brief: "a single icon you can click to show a menu (similar to a
    /// right click menu)") — built fresh from the SAME shared
    /// Navigation/AppNavigationItems.cs list the tray menu uses, so the
    /// two can never drift apart on labels/order/hotkey text.
    /// </summary>
    private void Overlay_OnClick(object sender, MouseButtonEventArgs e)
    {
        var menu = new ContextMenu();

        foreach (var item in AppNavigationItems.Items)
        {
            var header = item.HotkeyText is { Length: > 0 } hotkey ? $"{item.Label} — {hotkey}" : item.Label;
            var menuItem = new MenuItem { Header = header };
            var captured = item;
            menuItem.Click += (_, _) => Raise(captured);
            menu.Items.Add(menuItem);
        }

        menu.PlacementTarget = IconBorder;
        menu.IsOpen = true;
    }

    private void Raise(NavItem item)
    {
        switch (item.Kind)
        {
            case NavItemKind.DataEntryPopup:
                DataEntryRequested?.Invoke(this, EventArgs.Empty);
                break;
            case NavItemKind.MacroCodesPopup:
                MacroCodesRequested?.Invoke(this, EventArgs.Empty);
                break;
            case NavItemKind.CloudRoute:
            default:
                if (item.RelativePath is { Length: > 0 } path)
                {
                    NavigationRequested?.Invoke(this, path);
                }
                break;
        }
    }
}
