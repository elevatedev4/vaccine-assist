using System.Drawing;
using VaccineAssist.Desktop.Overlay;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Covers OverlayPlacement.Compute's pure DIP -> physical-pixel math (Will's
/// brief, Part 4) at 100% and 150% DPI. See that class's doc comment for
/// the exact formula (right-aligned with Rx Verify's own control box at
/// Pioneer.Right - 30, sitting 8 DIP below Rx Verify's 36-DIP bar).
/// </summary>
public class OverlayPlacementTests
{
    [Fact]
    public void At100PercentDpiTheIconIsRightAlignedWithRxVerifysBoxAndSitsBelowIt()
    {
        var pioneerBounds = Rectangle.FromLTRB(left: 100, top: 100, right: 1900, bottom: 1100);

        var rect = OverlayPlacement.Compute(pioneerBounds, dpiScale: 1.0);

        Assert.Equal(36, rect.Width);
        Assert.Equal(36, rect.Height);
        // LEFT = Right - 30 - 36 = 1900 - 66 = 1834
        Assert.Equal(1834, rect.X);
        // TOP = Top + 60 + 36 + 8 = 100 + 104 = 204
        Assert.Equal(204, rect.Y);
    }

    [Fact]
    public void At150PercentDpiEveryDimensionScalesUniformly()
    {
        var pioneerBounds = Rectangle.FromLTRB(left: 100, top: 100, right: 1900, bottom: 1100);

        var rect = OverlayPlacement.Compute(pioneerBounds, dpiScale: 1.5);

        Assert.Equal(54, rect.Width);   // 36 * 1.5
        Assert.Equal(54, rect.Height);  // 36 * 1.5
        // LEFT = 1900 - round(66 * 1.5) = 1900 - 99 = 1801
        Assert.Equal(1801, rect.X);
        // TOP = 100 + round(104 * 1.5) = 100 + 156 = 256
        Assert.Equal(256, rect.Y);
    }

    [Fact]
    public void TheIconsRightEdgeAlwaysLinesUpWithRxVerifysBoxRightEdge()
    {
        var pioneerBounds = Rectangle.FromLTRB(left: 0, top: 0, right: 2560, bottom: 1440);

        var rect100 = OverlayPlacement.Compute(pioneerBounds, dpiScale: 1.0);
        var rect150 = OverlayPlacement.Compute(pioneerBounds, dpiScale: 1.5);

        // Right edge = X + Width should sit at pioneerBounds.Right - 30dip (scaled).
        Assert.Equal(pioneerBounds.Right - 30, rect100.X + rect100.Width);
        Assert.Equal(pioneerBounds.Right - 45, rect150.X + rect150.Width); // 30 * 1.5 = 45
    }

    /// <summary>
    /// V-T41 R5 (Will's brief, item 4): the "entry in progress" panel sits
    /// immediately LEFT of the icon and is vertically centered against it.
    /// </summary>
    [Fact]
    public void EntryStatusPanelSitsImmediatelyLeftOfTheIconAndIsVerticallyCentered()
    {
        var iconRect = new OverlayRect(X: 1834, Y: 204, Width: 36, Height: 36);

        var statusRect = OverlayPlacement.ComputeEntryStatus(iconRect, dpiScale: 1.0);

        Assert.Equal(230, statusRect.Width);
        Assert.Equal(40, statusRect.Height);
        // Right edge of the panel = icon's left edge - 8dip gap.
        Assert.Equal(iconRect.X - 8, statusRect.X + statusRect.Width);
        // Vertically centered against the icon.
        Assert.Equal(iconRect.Y + (iconRect.Height - statusRect.Height) / 2, statusRect.Y);
    }

    [Fact]
    public void EntryStatusPanelScalesWithDpiLikeTheIconDoes()
    {
        var iconRect = OverlayPlacement.Compute(Rectangle.FromLTRB(0, 0, 2560, 1440), dpiScale: 1.5);

        var statusRect = OverlayPlacement.ComputeEntryStatus(iconRect, dpiScale: 1.5);

        Assert.Equal(345, statusRect.Width);  // 230 * 1.5
        Assert.Equal(60, statusRect.Height);  // 40 * 1.5
        Assert.Equal(iconRect.X - 12, statusRect.X + statusRect.Width); // 8 * 1.5 = 12
    }
}
