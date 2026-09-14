using System;
using System.Drawing;

namespace VaccineAssist.Desktop.Overlay;

/// <summary>Physical-pixel rect for SetWindowPos — see PioneerOverlayController.Reposition.</summary>
public readonly record struct OverlayRect(int X, int Y, int Width, int Height);

/// <summary>
/// Pure placement math for the Pioneer overlay icon (Will's brief, Part
/// 4) — no WPF/Win32 dependency, so it's unit-testable directly (see
/// VaccineAssist.Desktop.Tests\OverlayPlacementTests.cs), mirroring
/// rx-verify's own "positioning math lives in a pure static helper,
/// native calls are a separate thin wrapper" split
/// (Integrated/NativeWindowPositioning.cs there; Overlay/
/// NativeOverlayPositioning.cs here).
///
/// Will's brief, verbatim on placement: "it would need to sit below where
/// RxVerify does for the moment so it's not hidden" — rx-verify's own
/// control box (overlay/RxVerifyOverlay/Integrated/
/// IntegratedOverlayCoordinator.cs, ControlBoxRightInsetDip/
/// ControlBoxTopOffsetDip) anchors a 280x36 DIP box with its LEFT edge at
/// Pioneer.Right - 310 (i.e. its RIGHT edge at Pioneer.Right - 30) and its
/// TOP edge at Pioneer.Top + 60. This icon:
///   - RIGHT-aligns with that same Right - 30 edge (LEFT = Right - 30 - 36),
///     so the two overlays' right edges line up.
///   - Sits directly BELOW Rx Verify's 36-DIP-tall bar with an 8-DIP gap:
///     TOP = Pioneer.Top + 60 + 36 + 8 = Pioneer.Top + 104.
/// All in DIP, scaled to physical pixels by the caller-supplied
/// <paramref name="dpiScale"/> (GetDpiForWindow(pioneerHwnd) / 96.0 — see
/// NativeOverlayPositioning.DpiScaleFor), same "Pioneer's own DPI is
/// authoritative" reasoning IntegratedOverlayCoordinator.DpiScaleFor uses.
/// </summary>
public static class OverlayPlacement
{
    /// <summary>The overlay icon's own size, in DIP — 36x36 per the brief.</summary>
    public const double IconSizeDip = 36;

    /// <summary>Rx Verify's control box's own right edge sits this far in from Pioneer's right edge (Right - 30) — see class doc.</summary>
    private const double RightInsetDip = 30;

    /// <summary>Rx Verify's top offset (60) + its own 36-DIP bar height + an 8-DIP gap = 104.</summary>
    private const double TopOffsetDip = 104;

    public static OverlayRect Compute(Rectangle pioneerBounds, double dpiScale)
    {
        var width = ToPhysical(IconSizeDip, dpiScale);
        var height = ToPhysical(IconSizeDip, dpiScale);
        var x = pioneerBounds.Right - ToPhysical(RightInsetDip + IconSizeDip, dpiScale);
        var y = pioneerBounds.Top + ToPhysical(TopOffsetDip, dpiScale);
        return new OverlayRect(x, y, width, height);
    }

    private static int ToPhysical(double dip, double dpiScale) => (int)Math.Round(dip * dpiScale);
}
