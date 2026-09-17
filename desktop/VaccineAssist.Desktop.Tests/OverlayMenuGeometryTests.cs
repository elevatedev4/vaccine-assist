using VaccineAssist.Desktop.Overlay;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Covers OverlayMenuGeometry.IsPointOutsideMenu's pure "is this screen
/// point outside the menu's bounds" check (V-T42 — see that class's doc
/// comment for why PioneerOverlayWindow needs this at all: the menu sits
/// over Pioneer, a separate process, so a plain WPF ContextMenu's own
/// outside-click handling can't be relied on for a click landing there).
/// </summary>
public class OverlayMenuGeometryTests
{
    private static readonly OverlayRect MenuBounds = new(X: 100, Y: 200, Width: 150, Height: 300);

    [Fact]
    public void PointInsideTheMenuIsNotOutside()
    {
        Assert.False(OverlayMenuGeometry.IsPointOutsideMenu(MenuBounds, x: 150, y: 250));
    }

    [Fact]
    public void PointOnTheTopLeftEdgeIsInside()
    {
        Assert.False(OverlayMenuGeometry.IsPointOutsideMenu(MenuBounds, x: 100, y: 200));
    }

    [Fact]
    public void PointOnTheBottomRightEdgeIsOutside()
    {
        // Half-open rectangle: X + Width / Y + Height themselves are just past the menu.
        Assert.True(OverlayMenuGeometry.IsPointOutsideMenu(MenuBounds, x: 250, y: 500));
    }

    [Theory]
    [InlineData(99, 250)]  // just left of the menu
    [InlineData(251, 250)] // just right of the menu
    [InlineData(150, 199)] // just above the menu
    [InlineData(150, 501)] // just below the menu
    [InlineData(0, 0)]     // Pioneer's own window, far away
    public void PointOutsideTheMenuBoundsIsOutside(int x, int y)
    {
        Assert.True(OverlayMenuGeometry.IsPointOutsideMenu(MenuBounds, x, y));
    }
}
