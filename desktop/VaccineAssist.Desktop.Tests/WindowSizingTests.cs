using VaccineAssist.Desktop.Common;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Covers WindowSizing's pure work-area clamp math (2026-09-25 screen-width
/// pass, Will: "make sure the widths of all the screens are enough ...
/// like I just looked at the lots page and it wasn't wide enough") — same
/// 40px-margin convention Views/MacroCodesWindow.xaml.cs already applies
/// inline, extracted here so it's directly unit-testable.
/// </summary>
public class WindowSizingTests
{
    [Fact]
    public void ADesiredSizeSmallerThanTheWorkAreaIsReturnedUnchanged()
    {
        var (width, height) = WindowSizing.ClampToWorkArea(
            desiredWidth: 1600, desiredHeight: 900,
            workAreaWidth: 1920, workAreaHeight: 1080);

        Assert.Equal(1600, width);
        Assert.Equal(900, height);
    }

    [Fact]
    public void ADesiredSizeLargerThanTheWorkAreaIsClampedWithA40PxMargin()
    {
        // A 1600x900 desired size on a smaller 1366x768 laptop screen.
        var (width, height) = WindowSizing.ClampToWorkArea(
            desiredWidth: 1600, desiredHeight: 900,
            workAreaWidth: 1366, workAreaHeight: 768);

        Assert.Equal(1326, width);  // 1366 - 40
        Assert.Equal(728, height);  // 768 - 40
    }

    [Fact]
    public void OnlyTheOversizedDimensionIsClamped()
    {
        // Wide-but-short work area: width fits, height doesn't.
        var (width, height) = WindowSizing.ClampToWorkArea(
            desiredWidth: 1600, desiredHeight: 900,
            workAreaWidth: 3440, workAreaHeight: 860);

        Assert.Equal(1600, width);
        Assert.Equal(820, height); // 860 - 40
    }

    [Fact]
    public void ACustomMarginIsHonored()
    {
        var (width, height) = WindowSizing.ClampToWorkArea(
            desiredWidth: 900, desiredHeight: 600,
            workAreaWidth: 800, workAreaHeight: 500,
            margin: 20);

        Assert.Equal(780, width);  // 800 - 20
        Assert.Equal(480, height); // 500 - 20
    }

    [Fact]
    public void ClampDimensionMatchesTheExistingMacroCodesWindowInlineFormula()
    {
        // Views/MacroCodesWindow.xaml.cs: Width = Math.Min(Width, SystemParameters.WorkArea.Width - 40);
        var clamped = WindowSizing.ClampDimension(desired: 1375, workAreaDimension: 1280);

        Assert.Equal(1240, clamped); // 1280 - 40
    }
}
