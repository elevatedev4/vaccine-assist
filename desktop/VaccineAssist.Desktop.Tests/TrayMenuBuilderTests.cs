using System.Linq;
using VaccineAssist.Desktop.Tray;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Unit tests for TrayMenuBuilder.Build() — the pure description of the
/// tray icon's context menu. TrayIconController itself (the
/// System.Windows.Forms.NotifyIcon/ContextMenuStrip glue) isn't unit
/// tested, same reasoning as GlobalHotKey vs. HotKeyMessage: the OS-facing
/// wrapper is thin and untestable headlessly, so the actual menu
/// content/ordering logic lives here instead, where it can be.
///
/// V-T-single-nav Part 3 (2026-09-14): rewritten for the new menu shape —
/// the 8 shared nav items (Navigation/AppNavigationItems.cs) followed by
/// Open/Show Pioneer overlay/Sign out/Exit, replacing the old fixed
/// 4-item Open/MacroCodesHint/SignOut/Exit menu.
/// </summary>
public class TrayMenuBuilderTests
{
    [Fact]
    public void BuildsTheNavItemsFollowedByTheAppLevelRowsInOrder()
    {
        var items = TrayMenuBuilder.Build();

        var actions = items.Select(i => i.Action).ToArray();
        Assert.Equal(
            new[]
            {
                TrayMenuAction.Navigate,   // Schedule
                TrayMenuAction.Navigate,   // Ordering
                TrayMenuAction.DataEntry,  // Data entry
                TrayMenuAction.Navigate,   // Screener
                TrayMenuAction.Navigate,   // Lots
                TrayMenuAction.MacroCodes, // Macro codes
                TrayMenuAction.Navigate,   // Entry values
                TrayMenuAction.Navigate,   // Settings
                TrayMenuAction.Separator,
                TrayMenuAction.Open,
                TrayMenuAction.ToggleOverlay,
                TrayMenuAction.Separator,
                TrayMenuAction.SignOut,
                TrayMenuAction.Exit,
            },
            actions);
    }

    [Fact]
    public void DataEntryAndMacroCodesTextIncludeTheirHotkey()
    {
        var items = TrayMenuBuilder.Build();

        Assert.Contains(items, i => i.Text == "Data entry — Ctrl+NumPad7");
        Assert.Contains(items, i => i.Text == "Macro codes — Ctrl+Keypad 8");
    }

    [Fact]
    public void NavigateItemsCarryTheirCloudRelativePath()
    {
        var items = TrayMenuBuilder.Build();

        var schedule = items.Single(i => i.Text == "Schedule");
        Assert.Equal("/appointments", schedule.RelativePath);
        Assert.Equal(TrayMenuAction.Navigate, schedule.Action);
    }

    [Fact]
    public void OnlyTheToggleOverlayRowIsCheckable()
    {
        var items = TrayMenuBuilder.Build();

        foreach (var item in items)
        {
            Assert.Equal(item.Action == TrayMenuAction.ToggleOverlay, item.IsCheckable);
        }
    }

    [Fact]
    public void EveryNonSeparatorRowIsEnabled()
    {
        var items = TrayMenuBuilder.Build();

        foreach (var item in items.Where(i => i.Action != TrayMenuAction.Separator))
        {
            Assert.True(item.Enabled);
        }
    }
}
