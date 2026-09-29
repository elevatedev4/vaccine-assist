using VaccineAssist.Desktop.Overlay;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Unit tests for PioneerOverlayVisibilityGate — Will's 2026-09-29
/// thread message, verbatim: "Vaccine assist desktop app: When pioneer
/// is not focused, hide the blue icon, just like we do with RxVerify."
/// Mirrors rx-verify's own IntegratedVisibilityGateTests.cs coverage
/// shape for ShouldShowControlBox.
/// </summary>
public class PioneerOverlayVisibilityGateTests
{
    [Fact]
    public void ShowsWhenSettingOnMainWindowPresentNotMinimizedAndPioneerForeground()
    {
        Assert.True(PioneerOverlayVisibilityGate.ShouldShow(
            settingEnabled: true,
            hasMainWindow: true,
            isMainWindowMinimized: false,
            isPioneerForegroundApp: true));
    }

    [Fact]
    public void HiddenWhenSettingIsOffEvenIfPioneerIsForeground()
    {
        Assert.False(PioneerOverlayVisibilityGate.ShouldShow(
            settingEnabled: false,
            hasMainWindow: true,
            isMainWindowMinimized: false,
            isPioneerForegroundApp: true));
    }

    [Fact]
    public void HiddenWhenNoMainWindowExists()
    {
        Assert.False(PioneerOverlayVisibilityGate.ShouldShow(
            settingEnabled: true,
            hasMainWindow: false,
            isMainWindowMinimized: false,
            isPioneerForegroundApp: true));
    }

    [Fact]
    public void HiddenWhenMainWindowIsMinimized()
    {
        Assert.False(PioneerOverlayVisibilityGate.ShouldShow(
            settingEnabled: true,
            hasMainWindow: true,
            isMainWindowMinimized: true,
            isPioneerForegroundApp: true));
    }

    /// <summary>The exact ask: Pioneer exists, is maximized/open, but the
    /// pharmacist has switched to another application — the icon must
    /// hide even though it would otherwise be perfectly eligible to
    /// anchor and show.</summary>
    [Fact]
    public void HiddenWhenPioneerIsNotTheForegroundApp()
    {
        Assert.False(PioneerOverlayVisibilityGate.ShouldShow(
            settingEnabled: true,
            hasMainWindow: true,
            isMainWindowMinimized: false,
            isPioneerForegroundApp: false));
    }
}
