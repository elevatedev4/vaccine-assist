using System;

namespace VaccineAssist.Desktop.Common;

/// <summary>
/// Pure work-area clamp math for a window's default size — no WPF
/// dependency, so it's unit-testable directly (see
/// VaccineAssist.Desktop.Tests\WindowSizingTests.cs), same "pure math in a
/// static helper, the Window/native call is a separate thin wrapper" split
/// OverlayPlacement.cs already uses for the overlay icon.
///
/// Extracted from the clamp Views/MacroCodesWindow.xaml.cs's constructor
/// already applied inline (Will, 2026-09-25 round 2: "Make the maro code
/// popup be a litle bigger" — Width = Math.Min(Width,
/// SystemParameters.WorkArea.Width - 40), same for Height) so the same
/// "never exceed a smaller monitor's visible work area, 40px margin on
/// each side" rule can be reused (and tested) everywhere a window sets a
/// fixed default Width/Height in its constructor — MainWindow and
/// FaxRunSummaryWindow as of this pass (2026-09-25, Will: "make sure the
/// widths of all the screens are enough ... like I just looked at the
/// lots page and it wasn't wide enough").
/// </summary>
public static class WindowSizing
{
    /// <summary>Margin (in DIP) left free on each dimension between the clamped window size and the monitor's visible work area — matches MacroCodesWindow.xaml.cs's existing convention.</summary>
    public const double DefaultWorkAreaMargin = 40;

    /// <summary>Absolute floor for a clamped MinWidth (see <see cref="ClampMinimums"/>) — small enough to fit any real RDP/Citrix work area, but never so small the window becomes unusable.</summary>
    public const double DefaultMinWidthFloor = 800;

    /// <summary>Absolute floor for a clamped MinHeight — see <see cref="DefaultMinWidthFloor"/>.</summary>
    public const double DefaultMinHeightFloor = 500;

    /// <summary>Clamps a single desired dimension (Width or Height) to at most <paramref name="workAreaDimension"/> minus <paramref name="margin"/>, so the window never exceeds a smaller monitor's visible work area. Never clamps UPWARD — a desired size smaller than the work area is returned unchanged.</summary>
    public static double ClampDimension(double desired, double workAreaDimension, double margin = DefaultWorkAreaMargin)
        => Math.Min(desired, workAreaDimension - margin);

    /// <summary>Clamps a desired (Width, Height) pair to the given work area in one call — see <see cref="ClampDimension"/>.</summary>
    public static (double Width, double Height) ClampToWorkArea(
        double desiredWidth,
        double desiredHeight,
        double workAreaWidth,
        double workAreaHeight,
        double margin = DefaultWorkAreaMargin)
        => (
            ClampDimension(desiredWidth, workAreaWidth, margin),
            ClampDimension(desiredHeight, workAreaHeight, margin));

    /// <summary>
    /// Clamps a window's own MinWidth/MinHeight down to (at most) the
    /// already-clamped default size, so WPF never enforces a hard floor
    /// bigger than the work area it was just clamped to (reviewer fix,
    /// 2026-09-25: ClampToWorkArea alone adjusts Width/Height, but WPF
    /// still treats MinWidth/MinHeight as hard floors — on a 1024x768
    /// work area a MinWidth of 1100 renders the window 116px past the
    /// visible desktop, e.g. over RDP/Citrix). Falls back to
    /// <paramref name="floorWidth"/>/<paramref name="floorHeight"/> (never
    /// clamping the minimum BELOW that absolute floor) so the window
    /// still stays usable rather than shrinking to fit an extreme,
    /// unrealistically tiny work area.
    /// </summary>
    public static (double MinWidth, double MinHeight) ClampMinimums(
        double minWidth,
        double minHeight,
        double clampedWidth,
        double clampedHeight,
        double floorWidth = DefaultMinWidthFloor,
        double floorHeight = DefaultMinHeightFloor)
        => (
            Math.Max(Math.Min(minWidth, clampedWidth), floorWidth),
            Math.Max(Math.Min(minHeight, clampedHeight), floorHeight));
}
