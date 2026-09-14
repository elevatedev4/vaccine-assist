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
/// OpenRequested/SignOutRequested/ExitRequested to do the actual window/
/// auth work — this class only knows about the icon and menu, not
/// anything about signing in/out or WPF windows.
/// </summary>
public sealed class TrayIconController : IDisposable
{
    private readonly NotifyIcon _notifyIcon;

    public event EventHandler? OpenRequested;
    public event EventHandler? SignOutRequested;
    public event EventHandler? ExitRequested;

    public TrayIconController()
    {
        var menu = new ContextMenuStrip();
        foreach (var item in TrayMenuBuilder.Build())
        {
            if (item.Action == TrayMenuAction.MacroCodesHint)
            {
                // Informational only — Will: "only show Ctrl+Keypad 8 ...
                // I don't want the staff to get confused" — a disabled
                // label, not a real separator, keeps it visually distinct
                // from the three real actions without a click doing
                // anything.
                menu.Items.Add(new ToolStripMenuItem(item.Text) { Enabled = false });
                menu.Items.Add(new ToolStripSeparator());
                continue;
            }

            var menuItem = new ToolStripMenuItem(item.Text) { Enabled = item.Enabled };
            menuItem.Click += (_, _) => RaiseAction(item.Action);
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

    private void RaiseAction(TrayMenuAction action)
    {
        switch (action)
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
            case TrayMenuAction.MacroCodesHint:
                break; // informational row — never wired to a Click handler
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
