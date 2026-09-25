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

    // Reviewer fix (2026-09-25): MinWidth/MinHeight are hard floors in
    // WPF — ClampToWorkArea alone (above) only adjusts the default Width/
    // Height, so a window whose XAML sets MinWidth="1100" MinHeight="700"
    // (MainWindow's actual values) still gets forced past a smaller work
    // area unless the minimums are ALSO clamped down to the already-
    // clamped default size. These facts mirror MainWindow's real
    // 1600x900 desired size / 1100x700 minimums against the RDP/Citrix
    // work areas the blocker named.

    [Fact]
    public void On1024x768TheMinWidthIsPulledDownToTheClampedWidth()
    {
        // clampedWidth = 1024 - 40 = 984; MinWidth 1100 would otherwise
        // render 116px past the visible desktop.
        var (minWidth, minHeight) = WindowSizing.ClampMinimums(
            minWidth: 1100, minHeight: 700,
            clampedWidth: 984, clampedHeight: 728);

        Assert.Equal(984, minWidth);
        Assert.Equal(700, minHeight); // 700 already fits under 728 — unchanged
    }

    [Fact]
    public void On1280x720TheMinHeightIsPulledDownToTheClampedHeight()
    {
        // clampedHeight = 720 - 40 = 680; MinHeight 700 would otherwise
        // force the window 20px past the visible desktop.
        var (minWidth, minHeight) = WindowSizing.ClampMinimums(
            minWidth: 1100, minHeight: 700,
            clampedWidth: 1240, clampedHeight: 680);

        Assert.Equal(1100, minWidth); // 1100 already fits under 1240 — unchanged
        Assert.Equal(680, minHeight);
    }

    [Fact]
    public void On1920x1080TheMinimumsAreUnchanged()
    {
        var (minWidth, minHeight) = WindowSizing.ClampMinimums(
            minWidth: 1100, minHeight: 700,
            clampedWidth: 1880, clampedHeight: 1040);

        Assert.Equal(1100, minWidth);
        Assert.Equal(700, minHeight);
    }

    [Fact]
    public void MinimumsNeverDropBelowTheAbsoluteUsabilityFloor()
    {
        // An unrealistically tiny work area (smaller than even the
        // absolute floor) — the floor wins rather than shrinking the
        // window below a usable size.
        var (minWidth, minHeight) = WindowSizing.ClampMinimums(
            minWidth: 1100, minHeight: 700,
            clampedWidth: 750, clampedHeight: 450,
            floorWidth: 800, floorHeight: 500);

        Assert.Equal(800, minWidth);
        Assert.Equal(500, minHeight);
    }
}
