using System;
using VaccineAssist.Desktop.Uia;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// WindowInfoDiagnostics — V-T41 ROUND 3's NO-PHI window-considered log
/// formatter (Will's brief, point 4: "class, title LENGTH only, visible,
/// enabled, rect size, style/exstyle hex, owner hwnd, and the decision").
/// The one property under test that actually matters for patient-data
/// safety: the window's TITLE TEXT must never appear in the output, only
/// its length.
/// </summary>
public class WindowInfoDiagnosticsTests
{
    [Fact]
    public void DescribeNoPhiNeverContainsTheTitleTextOnlyItsLength()
    {
        var info = new WindowInfo(new IntPtr(1), "Rx Profile - Smith, Jane", 1234, IntPtr.Zero, false, true,
            ClassName: "#32770", IsVisible: true, IsEnabled: true, Width: 300, Height: 150);

        var described = WindowInfoDiagnostics.DescribeNoPhi(info);

        Assert.DoesNotContain("Smith", described, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Jane", described, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Rx Profile", described);
        Assert.Contains($"titleLen={"Rx Profile - Smith, Jane".Length}", described);
    }

    [Fact]
    public void DescribeNoPhiIncludesClassVisibleEnabledSizeStyleAndOwner()
    {
        var info = new WindowInfo(new IntPtr(0x42), "", 1234, new IntPtr(0x99), false, true,
            ClassName: "WindowsForms10.Window.0.app.0.37e3228_r7_ad1", IsVisible: false, IsEnabled: false,
            Width: 0, Height: 0, Style: 0x10000000, ExStyle: 0x00000080);

        var described = WindowInfoDiagnostics.DescribeNoPhi(info);

        Assert.Contains("class='WindowsForms10.Window.0.app.0.37e3228_r7_ad1'", described);
        Assert.Contains("visible=False", described);
        Assert.Contains("enabled=False", described);
        Assert.Contains("size=0x0", described);
        Assert.Contains("exStyle=0x80", described);
        Assert.Contains("owner=0x99", described);
    }

    [Fact]
    public void DescribeNoPhiWithDecisionAppendsTheDecisionLabel()
    {
        var info = new WindowInfo(new IntPtr(1), "", 1234, IntPtr.Zero, false, false);

        var described = WindowInfoDiagnostics.DescribeNoPhiWithDecision(info, "ignored-nonblocking");

        Assert.EndsWith("decision=ignored-nonblocking", described);
    }

    [Fact]
    public void DescribeNoPhiHandlesAnEmptyTitleAsLengthZero()
    {
        var info = new WindowInfo(new IntPtr(1), "", 1234, IntPtr.Zero, false, false);

        Assert.Contains("titleLen=0", WindowInfoDiagnostics.DescribeNoPhi(info));
    }
}
