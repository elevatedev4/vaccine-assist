using VaccineAssist.Desktop.Overlay;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>Will 2026-10-22: hide the overlay while PioneerRx shows its sign-in screen (title contains "Logon to PioneerRx").</summary>
public class PioneerLogonScreenTests
{
    [Theory]
    [InlineData("Logon to PioneerRx", true)]
    [InlineData("Logon to PioneerRx - Store 1", true)]
    [InlineData("PioneerRx - Logon to PioneerRx (v1)", true)]
    [InlineData("logon to pioneerrx", true)]
    [InlineData("PioneerRx", false)]
    [InlineData("Logon to something else", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void TitleMatcher(string? title, bool expected)
    {
        Assert.Equal(expected, PioneerLogonScreen.IsLogonTitle(title));
    }

    [Fact]
    public void Gate_HidesWhileTheLogonScreenIsVisible_AndShowsAgainWhenItIsGone()
    {
        Assert.False(PioneerOverlayVisibilityGate.ShouldShow(true, true, false, true, isLogonScreenVisible: true));
        Assert.True(PioneerOverlayVisibilityGate.ShouldShow(true, true, false, true, isLogonScreenVisible: false));
    }

    [Fact]
    public void Gate_DefaultKeepsTheOldBehaviour()
    {
        Assert.True(PioneerOverlayVisibilityGate.ShouldShow(true, true, false, true));
    }

    [Theory]
    [InlineData("chrome", true)]
    [InlineData("msedge", true)]
    [InlineData("Firefox", true)]
    [InlineData("brave", true)]
    [InlineData("opera", true)]
    [InlineData("iexplore", true)]
    [InlineData("OUTLOOK", true)]
    [InlineData("outlook.exe", true)]
    [InlineData("VaccineAssist.Desktop", true)]
    [InlineData("PioneerRx", false)]
    [InlineData("PioneerRx.Login", false)]
    [InlineData("", false)]
    [InlineData(null, false)] // a failed process lookup counts as not excluded
    public void ExcludedProcesses(string? processName, bool expected)
    {
        Assert.Equal(expected, PioneerLogonScreen.IsExcludedProcess(processName));
    }
}
