using System.Collections.Generic;
using VaccineAssist.Desktop.Navigation;

namespace VaccineAssist.Desktop.Tray;

/// <summary>What a tray context-menu item does when clicked — TrayIconController
/// maps each of these to the real action (navigate the main WebView2, open
/// a popup, restore the window, toggle the Pioneer overlay, sign out, or
/// exit) or, for Separator, to a plain ToolStripSeparator.</summary>
public enum TrayMenuAction
{
    Navigate,
    DataEntry,
    MacroCodes,
    Open,
    ToggleOverlay,
    SignOut,
    Exit,
    Separator,
}

/// <summary>
/// One row of the tray icon's right-click menu. RelativePath is set only
/// for Navigate rows; IsCheckable only for ToggleOverlay (TrayIconController
/// reads the CURRENT "Show Pioneer overlay" setting separately to decide
/// that row's initial checked state — this descriptor only says the row
/// IS a checkbox, not whether it starts checked).
/// </summary>
public sealed record TrayMenuItemDescriptor(
    string Text,
    bool Enabled,
    TrayMenuAction Action,
    string? RelativePath = null,
    bool IsCheckable = false);

/// <summary>
/// Pure description of the tray icon's context menu (Will, 2026-09-13:
/// "have it be minimizable to the tray ... primarily interact with it
/// through hotkeys"), split out from TrayIconController so the menu's
/// shape/order/wording is unit-testable without touching
/// System.Windows.Forms.NotifyIcon/ContextMenuStrip at all — those can't
/// usefully be constructed in a headless xUnit run. TrayIconController is
/// the only production caller; it turns each descriptor into a real
/// ToolStripMenuItem/ToolStripSeparator and wires Click to the matching
/// action.
///
/// V-T-single-nav Part 3 (Will's brief, 2026-09-14): the menu is now built
/// from Navigation/AppNavigationItems.cs's shared 8-item list (Schedule/
/// Ordering/Data entry/Screener/Lots/Macro codes/Entry values/Settings —
/// same list the Pioneer overlay's click menu uses, see
/// Overlay/PioneerOverlayWindow.xaml.cs) followed by the app-level rows:
/// Open Vaccine Assist, Show Pioneer overlay (checkable), Sign out, Exit.
/// Replaces the old fixed 4-item Open/MacroCodesHint/SignOut/Exit menu —
/// "only show Ctrl+Keypad 8 ... 7 isn't working yet" no longer applies:
/// both hotkeys work now (V-T3 item 2 shipped), so both nav items carry
/// their real hotkey text inline, and neither is a disabled hint anymore.
/// </summary>
public static class TrayMenuBuilder
{
    public static IReadOnlyList<TrayMenuItemDescriptor> Build()
    {
        var items = new List<TrayMenuItemDescriptor>();

        foreach (var navItem in AppNavigationItems.Items)
        {
            var text = navItem.HotkeyText is { Length: > 0 } hotkey
                ? $"{navItem.Label} — {hotkey}"
                : navItem.Label;

            var action = navItem.Kind switch
            {
                NavItemKind.DataEntryPopup => TrayMenuAction.DataEntry,
                NavItemKind.MacroCodesPopup => TrayMenuAction.MacroCodes,
                _ => TrayMenuAction.Navigate,
            };

            // Every argument here is positional (in declared parameter
            // order) deliberately — mixing named and positional arguments
            // in a single call is fine in C# only in narrow cases, so
            // every TrayMenuItemDescriptor construction below just passes
            // all five positional slots explicitly instead.
            items.Add(new TrayMenuItemDescriptor(text, true, action, navItem.RelativePath, false));
        }

        items.Add(Separator);
        items.Add(new TrayMenuItemDescriptor("Open Vaccine Assist", true, TrayMenuAction.Open, null, false));
        items.Add(new TrayMenuItemDescriptor("Show Pioneer overlay", true, TrayMenuAction.ToggleOverlay, null, true));
        items.Add(Separator);
        items.Add(new TrayMenuItemDescriptor("Sign out", true, TrayMenuAction.SignOut, null, false));
        items.Add(new TrayMenuItemDescriptor("Exit", true, TrayMenuAction.Exit, null, false));

        return items;
    }

    private static TrayMenuItemDescriptor Separator { get; } = new("", true, TrayMenuAction.Separator);
}
