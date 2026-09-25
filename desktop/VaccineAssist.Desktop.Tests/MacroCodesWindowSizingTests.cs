using VaccineAssist.Desktop.Views;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// MacroCodesWindowSizing itself needs no WPF Window (see its own doc
/// comment), so it's covered here by fast xUnit tests, same "pure half"
/// split as AgeMacroCodesUrlBuilderTests/AgePromptInputTests. Covers the
/// macro-popup round 3 brief (Will's verbatim ask, 2026-09-25): "Make it
/// wider... and make the height fit only what it needs to be able to
/// show everything, not extra space at the bottom."
/// </summary>
public class MacroCodesWindowSizingTests
{
    [Fact]
    public void ComputeWidth_CapsAt1700()
    {
        var width = MacroCodesWindowSizing.ComputeWidth(3000);

        Assert.Equal(1700, width);
    }

    [Fact]
    public void ComputeWidth_LeavesAn80PxMarginOnASmallerScreen()
    {
        var width = MacroCodesWindowSizing.ComputeWidth(1440);

        Assert.Equal(1360, width);
    }

    [Fact]
    public void ComputeWidth_NeverGoesNegativeOnATinyWorkArea()
    {
        var width = MacroCodesWindowSizing.ComputeWidth(50);

        Assert.Equal(0, width);
    }

    [Fact]
    public void ComputeHeight_FitsContentPlusChromePlusSlack_WhenRoomAllows()
    {
        // 500 content + 40 chrome + 8 slack = 548, well under a
        // 1080-tall screen's (1080 - 40) = 1040 clamp.
        var height = MacroCodesWindowSizing.ComputeHeight(contentHeightPx: 500, chromeHeightPx: 40, workAreaHeight: 1080);

        Assert.Equal(548, height);
    }

    [Fact]
    public void ComputeHeight_ClampsToTheWorkAreaMinus40OnATallCatalog()
    {
        // 2000 content would exceed even a full 1080-tall screen — the
        // window itself must never exceed workAreaHeight - 40; the page
        // scrolls internally for the rest (see the cloud side's own
        // round-3 doc comment).
        var height = MacroCodesWindowSizing.ComputeHeight(contentHeightPx: 2000, chromeHeightPx: 40, workAreaHeight: 1080);

        Assert.Equal(1040, height);
    }

    [Fact]
    public void ComputeHeight_NeverGoesBelowMinHeight_ForATinyReportedContentHeight()
    {
        var height = MacroCodesWindowSizing.ComputeHeight(contentHeightPx: 10, chromeHeightPx: 40, workAreaHeight: 1080);

        Assert.Equal(MacroCodesWindowSizing.MinHeight, height);
    }

    [Fact]
    public void ComputeHeight_TreatsNegativeInputsAsZero_RatherThanGoingNegative()
    {
        var height = MacroCodesWindowSizing.ComputeHeight(contentHeightPx: -50, chromeHeightPx: -10, workAreaHeight: 1080);

        Assert.Equal(MacroCodesWindowSizing.MinHeight, height);
    }

    [Fact]
    public void ComputeCenteredPosition_CentersWithinTheWorkArea()
    {
        var (left, top) = MacroCodesWindowSizing.ComputeCenteredPosition(
            windowWidth: 1000,
            windowHeight: 600,
            workAreaLeft: 0,
            workAreaTop: 0,
            workAreaWidth: 1920,
            workAreaHeight: 1080);

        Assert.Equal(460, left);
        Assert.Equal(240, top);
    }

    [Fact]
    public void ComputeCenteredPosition_AccountsForANonZeroWorkAreaOrigin()
    {
        // A secondary monitor to the left of the primary has a negative
        // WorkArea.Left — the centering math must add it back rather
        // than assuming the work area starts at (0,0).
        var (left, top) = MacroCodesWindowSizing.ComputeCenteredPosition(
            windowWidth: 1000,
            windowHeight: 600,
            workAreaLeft: -1920,
            workAreaTop: 0,
            workAreaWidth: 1920,
            workAreaHeight: 1080);

        Assert.Equal(-1920 + 460, left);
        Assert.Equal(240, top);
    }
}
