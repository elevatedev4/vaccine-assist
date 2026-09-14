using System.Linq;
using VaccineAssist.Desktop.Navigation;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-T-single-nav Part 3: the ONE shared nav-item list behind both the
/// tray menu (Tray/TrayMenuBuilder.cs) and the Pioneer overlay's click
/// menu (Overlay/PioneerOverlayWindow.xaml.cs). Exact labels/order/hotkey
/// text asserted here so a future edit to one call site can't silently
/// drift from the other — both are built from this exact list.
/// </summary>
public class AppNavigationItemsTests
{
    [Fact]
    public void HasExactlyTheseLabelsInThisOrder()
    {
        var labels = AppNavigationItems.Items.Select(i => i.Label).ToArray();

        Assert.Equal(
            new[] { "Schedule", "Ordering", "Data entry", "Screener", "Lots", "Macro codes", "Entry values", "Settings" },
            labels);
    }

    [Fact]
    public void DataEntryAndMacroCodesCarryTheirHotkeyText()
    {
        var dataEntry = AppNavigationItems.Items.Single(i => i.Label == "Data entry");
        Assert.Equal("Ctrl+NumPad7", dataEntry.HotkeyText);
        Assert.Null(dataEntry.RelativePath);
        Assert.Equal(NavItemKind.DataEntryPopup, dataEntry.Kind);

        var macroCodes = AppNavigationItems.Items.Single(i => i.Label == "Macro codes");
        Assert.Equal("Ctrl+Keypad 8", macroCodes.HotkeyText);
        Assert.Null(macroCodes.RelativePath);
        Assert.Equal(NavItemKind.MacroCodesPopup, macroCodes.Kind);
    }

    [Fact]
    public void EveryOtherItemIsACloudRouteWithNoHotkeyText()
    {
        var others = AppNavigationItems.Items.Where(i => i.Label != "Data entry" && i.Label != "Macro codes");

        foreach (var item in others)
        {
            Assert.Null(item.HotkeyText);
            Assert.Equal(NavItemKind.CloudRoute, item.Kind);
            Assert.False(string.IsNullOrWhiteSpace(item.RelativePath));
        }
    }

    [Theory]
    [InlineData("Schedule", "/appointments")]
    [InlineData("Ordering", "/ordering")]
    [InlineData("Screener", "/screener")]
    [InlineData("Lots", "/lots")]
    [InlineData("Entry values", "/entry-values")]
    [InlineData("Settings", "/settings")]
    public void CloudRoutesMatchTheRealCloudAppRouteFolders(string label, string expectedPath)
    {
        var item = AppNavigationItems.Items.Single(i => i.Label == label);
        Assert.Equal(expectedPath, item.RelativePath);
    }
}
