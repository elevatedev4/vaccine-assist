using System.Collections.Generic;

namespace VaccineAssist.Desktop.Tray;

/// <summary>What a tray context-menu item does when clicked — TrayIconController
/// maps each of these to the real action (restore the window, sign out,
/// exit) or, for Hint, to nothing (it's informational only).</summary>
public enum TrayMenuAction
{
    Open,
    MacroCodesHint,
    SignOut,
    Exit,
}

/// <summary>One row of the tray icon's right-click menu.</summary>
public sealed record TrayMenuItemDescriptor(string Text, bool Enabled, TrayMenuAction Action);

/// <summary>
/// Pure description of the tray icon's context menu (Will, 2026-09-13:
/// "have it be minimizable to the tray ... primarily interact with it
/// through hotkeys"), split out from TrayIconController so the menu's
/// shape/order/wording is unit-testable without touching
/// System.Windows.Forms.NotifyIcon/ContextMenuStrip at all — those can't
/// usefully be constructed in a headless xUnit run. TrayIconController is
/// the only production caller; it turns each descriptor into a real
/// ToolStripMenuItem and wires Click to the matching event.
///
/// Only Ctrl+Keypad 8 is mentioned (matches EntryView's greeting card) —
/// Will, verbatim: "only show Ctrl+Keypad 8 as the option because 7 isn't
/// working yet and I don't want the staff to get confused." The hint
/// item is deliberately disabled (Enabled: false) — it's a label, not a
/// clickable action.
/// </summary>
public static class TrayMenuBuilder
{
    public static IReadOnlyList<TrayMenuItemDescriptor> Build() => new[]
    {
        new TrayMenuItemDescriptor("Open Vaccine Assist", Enabled: true, TrayMenuAction.Open),
        new TrayMenuItemDescriptor("Ctrl+Keypad 8 — macro codes", Enabled: false, TrayMenuAction.MacroCodesHint),
        new TrayMenuItemDescriptor("Sign out", Enabled: true, TrayMenuAction.SignOut),
        new TrayMenuItemDescriptor("Exit", Enabled: true, TrayMenuAction.Exit),
    };
}
