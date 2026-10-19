using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using VaccineAssist.Desktop.Navigation;
using VaccineAssist.Desktop.Versioning;

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

    /// <summary>Raised when the menu's trailing "Exit" row is clicked — same
    /// *Requested shape as the others so PioneerOverlayController wires it
    /// the same way (see class doc comment). Owner's ask, 2026-09-21: "a
    /// quick way to close the app" from the vaccine icon's popup menu.</summary>
    public event EventHandler? ExitRequested;

    /// <summary>Raised with the chosen version ref ("stable" or "testing/&lt;slug&gt;") when a Version submenu row is clicked.</summary>
    public event EventHandler<string>? VersionSwitchRequested;

    /// <summary>Source for the menu's "Version" submenu; null (never set) omits the submenu.</summary>
    public VersionMenuSource? Versions { get; set; }

    private MenuItem? _versionMenuItem;
    private OverlayRect? _openSubmenuScreenBounds;

    /// <summary>Raw HWND for PioneerOverlayController's SetWindowPos calls — IntPtr.Zero until SourceInitialized has run.</summary>
    public IntPtr Handle { get; private set; } = IntPtr.Zero;

    // V-T42 (Will, verbatim): "when I click on the vaccine icon on pioneer
    // and then click away from it, the menu should close but doesn't." A
    // plain ContextMenu's own close-on-outside-click handling can't be
    // relied on for a click landing on Pioneer (a separate process) — see
    // GlobalMouseDownHook's and OverlayMenuGeometry's own doc comments for
    // the full fix. This app has exactly one overlay menu open at a time,
    // so one hook instance for the window's whole lifetime is enough;
    // Install()/Uninstall() (cheap, idempotent) track whether it's
    // currently active.
    private readonly GlobalMouseDownHook _outsideClickHook = new();
    private ContextMenu? _openMenu;
    private OverlayRect _openMenuScreenBounds;

    public PioneerOverlayWindow()
    {
        InitializeComponent();
        SourceInitialized += OnSourceInitialized;
        Closed += (_, _) => _outsideClickHook.Dispose();
        _outsideClickHook.MouseDown += OnGlobalMouseDown;
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

        // Owner's ask (2026-09-21): "Add 'Exit' to the popup menu ... for a
        // quick way to close the app" — same trailing separator + Exit row
        // as the tray menu (Tray/TrayMenuBuilder.cs). No _openMenu/hook
        // handling needed here beyond what Raise's callers already get:
        // clicking any MenuItem closes this ContextMenu on its own, which
        // fires Menu_OnClosed and uninstalls the V-T42 outside-click hook.
        var exitItem = new MenuItem { Header = "Exit" };
        exitItem.Click += (_, _) => ExitRequested?.Invoke(this, EventArgs.Empty);
        menu.Items.Add(new Separator());
        if (Versions is not null)
        {
            _versionMenuItem = BuildVersionMenuItem();
            menu.Items.Add(_versionMenuItem);
        }
        menu.Items.Add(exitItem);

        menu.PlacementTarget = IconBorder;
        menu.Closed += Menu_OnClosed;
        menu.PreviewKeyDown += Menu_OnPreviewKeyDown;
        _openMenu = menu;
        menu.IsOpen = true;

        // V-T42: install the global outside-click fallback only once the
        // menu is actually open and laid out (ActualWidth/Height and
        // PointToScreen are only meaningful once it has a real
        // PresentationSource) — see class doc comment above and
        // GlobalMouseDownHook/OverlayMenuGeometry's own doc comments.
        menu.UpdateLayout();
        TryInstallOutsideClickHook(menu);
    }

    /// <summary>Best-effort — a failure here just means this menu falls
    /// back to WPF's own default close-on-outside-click behavior (which
    /// still works for a click inside one of this app's own windows), same
    /// posture as every other UI/native-interop helper in this
    /// codebase.</summary>
    private void TryInstallOutsideClickHook(ContextMenu menu)
    {
        try
        {
            var origin = menu.PointToScreen(new Point(0, 0));
            _openMenuScreenBounds = new OverlayRect(
                (int)Math.Round(origin.X),
                (int)Math.Round(origin.Y),
                (int)Math.Round(menu.ActualWidth),
                (int)Math.Round(menu.ActualHeight));
            _outsideClickHook.Install();
        }
        catch
        {
            // Best-effort — see doc comment above.
        }
    }

    private void OnGlobalMouseDown(int screenX, int screenY)
    {
        var menu = _openMenu;
        if (menu is null || !menu.IsOpen) return;
        if (!OverlayMenuGeometry.IsPointOutsideMenu(_openMenuScreenBounds, screenX, screenY)) return;

        // The Version submenu's popup lies outside the main menu's rect: a
        // click on one of its rows must not count as an outside click (it
        // would close the menu before the row's Click fires). If the
        // submenu's bounds are unknown, fall through and close normally.
        if (_versionMenuItem is { IsSubmenuOpen: true }
            && _openSubmenuScreenBounds is { } submenuBounds
            && !OverlayMenuGeometry.IsPointOutsideMenu(submenuBounds, screenX, screenY))
        {
            return;
        }

        // Posted back through the Dispatcher: the hook callback runs
        // synchronously inside Windows' own hook-chain dispatch, and
        // closing a Popup from within that reentrant context is best done
        // via a normal dispatcher callback rather than inline.
        Dispatcher.BeginInvoke(() =>
        {
            if (ReferenceEquals(_openMenu, menu))
            {
                menu.IsOpen = false;
            }
        });
    }

    /// <summary>V-T42: Escape also closes the menu — belt-and-suspenders
    /// alongside WPF's own default Escape-closes-a-ContextMenu behavior,
    /// since this menu's owner window opts out of activation
    /// (WS_EX_NOACTIVATE) in ways a normal ContextMenu owner never
    /// does.</summary>
    private void Menu_OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape && sender is ContextMenu menu)
        {
            menu.IsOpen = false;
        }
    }

    private void Menu_OnClosed(object sender, RoutedEventArgs e)
    {
        _outsideClickHook.Uninstall();
        if (sender is ContextMenu menu)
        {
            _versionMenuItem = null;
            _openSubmenuScreenBounds = null;
            menu.Closed -= Menu_OnClosed;
            menu.PreviewKeyDown -= Menu_OnPreviewKeyDown;
            if (ReferenceEquals(_openMenu, menu))
            {
                _openMenu = null;
            }
        }
    }

    private MenuItem BuildVersionMenuItem()
    {
        var versionItem = new MenuItem { Header = "Version" };
        PopulateVersionRows(versionItem);
        versionItem.SubmenuOpened += (_, _) => OnVersionSubmenuOpened(versionItem);
        versionItem.SubmenuClosed += (_, _) => _openSubmenuScreenBounds = null;
        return versionItem;
    }

    private void PopulateVersionRows(MenuItem versionItem)
    {
        versionItem.Items.Clear();
        if (Versions is null) return;

        foreach (var row in Versions.BuildItems())
        {
            var rowItem = new MenuItem { Header = row.Text, IsEnabled = row.Enabled, IsChecked = row.Checked };
            if (row.Enabled && row.Ref is { Length: > 0 } versionRef)
            {
                rowItem.Click += (_, _) => VersionSwitchRequested?.Invoke(this, versionRef);
            }
            versionItem.Items.Add(rowItem);
        }
    }

    /// <summary>Shows the last known list immediately, then refreshes the remote list on a background thread (never the UI thread) and repaints if the submenu is still open.</summary>
    private void OnVersionSubmenuOpened(MenuItem versionItem)
    {
        PopulateVersionRows(versionItem);
        TryUpdateSubmenuBounds(versionItem);
        if (Versions is null) return;

        Versions.Catalog.RefreshAsync().ContinueWith(
            _ => Dispatcher.BeginInvoke(() =>
            {
                if (versionItem.IsSubmenuOpen)
                {
                    PopulateVersionRows(versionItem);
                    TryUpdateSubmenuBounds(versionItem);
                }
            }),
            TaskScheduler.Default);
    }

    /// <summary>Best-effort screen bounds of the open submenu popup (physical pixels), for the outside-click check.</summary>
    private void TryUpdateSubmenuBounds(MenuItem versionItem)
    {
        try
        {
            if (versionItem.Template?.FindName("PART_Popup", versionItem) is Popup { Child: FrameworkElement child })
            {
                child.UpdateLayout();
                var origin = child.PointToScreen(new Point(0, 0));
                var dpi = VisualTreeHelper.GetDpi(child);
                _openSubmenuScreenBounds = new OverlayRect(
                    (int)Math.Round(origin.X),
                    (int)Math.Round(origin.Y),
                    (int)Math.Round(child.ActualWidth * dpi.DpiScaleX),
                    (int)Math.Round(child.ActualHeight * dpi.DpiScaleY));
            }
        }
        catch
        {
            _openSubmenuScreenBounds = null; // unknown bounds: OnGlobalMouseDown closes the menu normally
        }
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
