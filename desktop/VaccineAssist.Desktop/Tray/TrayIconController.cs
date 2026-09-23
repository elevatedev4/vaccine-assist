using System;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Tray;

/// <summary>
/// Owns the tray icon (Will, 2026-09-13: "we need to have it be
/// minimizable to the tray so that the user can access it when needed.
/// They will primarily interact with it through hotkeys, so they'll just
/// run it and minimize it immediately"). Uses the WinForms
/// System.Windows.Forms.NotifyIcon rather than a third-party WPF tray
/// package — WPF+WinForms interop for exactly this (a NotifyIcon plus a
/// ContextMenuStrip, nothing else from WinForms) is a standard, supported
/// combination and avoids a new NuGet dependency (see the csproj's
/// UseWindowsForms comment).
///
/// Deliberately has NO `using System.Windows;` — every WinForms type here
/// (NotifyIcon, ContextMenuStrip, ToolStripMenuItem, Icon) is used
/// unqualified, and this file never needs System.Windows.Application/
/// MessageBox/etc., so there's no ambiguity risk between the two
/// frameworks' identically-named types even if implicit usings ever
/// pulled in both (see the csproj's own `<Using Remove>` guard against
/// that anyway).
///
/// MainWindow owns exactly one instance for its whole lifetime (created
/// in the constructor, disposed in MainWindow_OnClosed) and subscribes to
/// its *Requested events to do the actual window/auth/navigation work —
/// this class only knows about the icon and menu, not anything about
/// signing in/out, WPF windows, or the cloud app's routes.
///
/// V-T-single-nav Part 3 (Will's brief, 2026-09-14): the menu now also
/// carries the 8 shared nav items (see TrayMenuBuilder/AppNavigationItems)
/// plus a checkable "Show Pioneer overlay" row — NavigationRequested/
/// DataEntryRequested/MacroCodesRequested/ShowOverlayToggled cover those.
/// </summary>
public sealed class TrayIconController : IDisposable
{
    private readonly NotifyIcon _notifyIcon;

    public event EventHandler? OpenRequested;
    public event EventHandler? SignOutRequested;
    public event EventHandler? ExitRequested;
    public event EventHandler? DataEntryRequested;
    public event EventHandler? MacroCodesRequested;

    /// <summary>V-T53: "Vaccine faxes — Run now" / "— Settings" / "Open
    /// fax folder" tray rows.</summary>
    public event EventHandler? FaxRunNowRequested;
    public event EventHandler? FaxSettingsRequested;
    public event EventHandler? FaxOpenFolderRequested;

    /// <summary>2026-09-22: "Vaccine faxes — Import report file…" — see
    /// MainWindow.xaml.cs's ImportReportFileAndRunAsync.</summary>
    public event EventHandler? FaxImportFileRequested;

    /// <summary>Raised with the cloud route to navigate to (e.g. "/lots") when a Navigate row is clicked.</summary>
    public event EventHandler<string>? NavigationRequested;

    /// <summary>Raised with the NEW checked state when "Show Pioneer overlay" is clicked.</summary>
    public event EventHandler<bool>? ShowOverlayToggled;

    /// <param name="showPioneerOverlayInitiallyChecked">Current value of
    /// the persisted "Show Pioneer overlay" setting (AppSettings.
    /// ShowPioneerOverlay) — sets the checkbox row's initial Checked state
    /// so the tray menu reflects the real setting instead of always
    /// starting unchecked.</param>
    public TrayIconController(bool showPioneerOverlayInitiallyChecked)
    {
        var menu = new ContextMenuStrip();
        foreach (var item in TrayMenuBuilder.Build())
        {
            if (item.Action == TrayMenuAction.Separator)
            {
                menu.Items.Add(new ToolStripSeparator());
                continue;
            }

            var menuItem = new ToolStripMenuItem(item.Text) { Enabled = item.Enabled };
            if (item.IsCheckable)
            {
                menuItem.CheckOnClick = false; // we flip Checked ourselves after the toggle is accepted, not optimistically
                menuItem.Checked = showPioneerOverlayInitiallyChecked;
            }

            var descriptor = item; // capture per-iteration copy for the closure below
            menuItem.Click += (_, _) => RaiseAction(descriptor, menuItem);
            menu.Items.Add(menuItem);
        }

        _notifyIcon = new NotifyIcon
        {
            Icon = LoadAppIcon(),
            Text = "Vaccine Assist",
            ContextMenuStrip = menu,
            Visible = true,
        };
        _notifyIcon.DoubleClick += (_, _) => OpenRequested?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>V-T53: "tray balloon 'Vaccine faxes: 12 sent, 1 failed, 2
    /// need a fax number'" after a run completes.</summary>
    public void ShowBalloonTip(string title, string text)
    {
        _notifyIcon.BalloonTipTitle = title;
        _notifyIcon.BalloonTipText = text;
        _notifyIcon.ShowBalloonTip(8000);
    }

    private void RaiseAction(TrayMenuItemDescriptor descriptor, ToolStripMenuItem menuItem)
    {
        switch (descriptor.Action)
        {
            case TrayMenuAction.Open:
                OpenRequested?.Invoke(this, EventArgs.Empty);
                break;
            case TrayMenuAction.SignOut:
                SignOutRequested?.Invoke(this, EventArgs.Empty);
                break;
            case TrayMenuAction.Exit:
                ExitRequested?.Invoke(this, EventArgs.Empty);
                break;
            case TrayMenuAction.DataEntry:
                DataEntryRequested?.Invoke(this, EventArgs.Empty);
                break;
            case TrayMenuAction.MacroCodes:
                MacroCodesRequested?.Invoke(this, EventArgs.Empty);
                break;
            case TrayMenuAction.FaxRunNow:
                FaxRunNowRequested?.Invoke(this, EventArgs.Empty);
                break;
            case TrayMenuAction.FaxSettings:
                FaxSettingsRequested?.Invoke(this, EventArgs.Empty);
                break;
            case TrayMenuAction.FaxOpenFolder:
                FaxOpenFolderRequested?.Invoke(this, EventArgs.Empty);
                break;
            case TrayMenuAction.FaxImportFile:
                FaxImportFileRequested?.Invoke(this, EventArgs.Empty);
                break;
            case TrayMenuAction.Navigate:
                if (descriptor.RelativePath is { Length: > 0 } path)
                {
                    NavigationRequested?.Invoke(this, path);
                }
                break;
            case TrayMenuAction.ToggleOverlay:
                var newState = !menuItem.Checked;
                menuItem.Checked = newState;
                ShowOverlayToggled?.Invoke(this, newState);
                break;
            case TrayMenuAction.Separator:
                break; // never wired to a Click handler
        }
    }

    /// <summary>
    /// No standalone .ico asset ships with this project yet (see the
    /// csproj's ApplicationIcon comment), so the tray icon is extracted
    /// from the running executable itself — whatever icon Explorer/Alt+Tab
    /// already show for VaccineAssist.Desktop.exe. If Will adds a real
    /// ApplicationIcon later, the tray icon picks it up automatically with
    /// no change needed here. Never throws — SystemIcons.Application is an
    /// always-available fallback.
    /// </summary>
    private static Icon LoadAppIcon()
    {
        try
        {
            var exePath = Process.GetCurrentProcess().MainModule?.FileName;
            if (!string.IsNullOrEmpty(exePath))
            {
                var icon = Icon.ExtractAssociatedIcon(exePath);
                if (icon is not null)
                {
                    return icon;
                }
            }
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("TrayIconController.LoadAppIcon", ex);
        }

        return SystemIcons.Application;
    }

    public void Dispose()
    {
        // Hiding before Dispose ensures the icon disappears from the tray
        // immediately rather than lingering until the next time Explorer
        // repaints that area (a well-known NotifyIcon quirk if you skip
        // straight to Dispose).
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
    }
}
