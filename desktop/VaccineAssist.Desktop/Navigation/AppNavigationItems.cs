using System.Collections.Generic;

namespace VaccineAssist.Desktop.Navigation;

/// <summary>What clicking a NavItem does.</summary>
public enum NavItemKind
{
    /// <summary>Navigate MainWindow's single WebView2 to RelativePath.</summary>
    CloudRoute,

    /// <summary>Open the native data-entry popup (DataEntryPopupWindow).</summary>
    DataEntryPopup,

    /// <summary>Open the macro-codes popup (MacroCodesWindow).</summary>
    MacroCodesPopup,
}

/// <summary>
/// One navigable destination in the app — RelativePath is set for
/// CloudRoute items (checked against the cloud app's real route folders,
/// cloud/app/*/page.tsx — not every label matches its path 1:1) and null
/// for the two popup items, which HotkeyText instead documents.
/// </summary>
public sealed record NavItem(string Label, string? RelativePath, string? HotkeyText, NavItemKind Kind);

/// <summary>
/// V-T-single-nav Part 3 (Will's brief): the ONE shared, WPF-free list of
/// app destinations behind both the tray icon's right-click menu
/// (Tray/TrayMenuBuilder.cs) and the Pioneer overlay icon's click menu
/// (Overlay/PioneerOverlayWindow.xaml.cs) — kept here, with no WPF
/// dependency at all, so both call sites (and this project's tests) build
/// their menu content from exactly the same list and can never drift
/// apart on labels, order, or which hotkey text belongs to which item.
///
/// Order matches the cloud app's own top nav (cloud/lib/nav-config.ts)
/// exactly, since Will's ask was "all the tabs in the app match exactly
/// what is in the cloud" — Data entry and Macro codes are POPUPS here
/// (DataEntryPopupWindow / MacroCodesWindow) rather than WebView2 routes,
/// same as before this change; RelativePath is null for those two and
/// HotkeyText instead names the global hotkey that already opens them.
/// </summary>
public static class AppNavigationItems
{
    public static IReadOnlyList<NavItem> Items { get; } = new[]
    {
        new NavItem("Schedule", "/appointments", null, NavItemKind.CloudRoute),
        new NavItem("Ordering", "/ordering", null, NavItemKind.CloudRoute),
        new NavItem("Data entry", null, "Ctrl+NumPad7", NavItemKind.DataEntryPopup),
        new NavItem("Screener", "/screener", null, NavItemKind.CloudRoute),
        new NavItem("Lots", "/lots", null, NavItemKind.CloudRoute),
        new NavItem("Macro codes", null, "Ctrl+Keypad 8", NavItemKind.MacroCodesPopup),
        new NavItem("Entry values", "/entry-values", null, NavItemKind.CloudRoute),
        new NavItem("Settings", "/settings", null, NavItemKind.CloudRoute),
    };
}
