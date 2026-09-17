namespace VaccineAssist.Desktop.Overlay;

/// <summary>
/// V-T42 (Will, verbatim): "when I click on the vaccine icon on pioneer and
/// then click away from it, the menu should close but doesn't." The
/// overlay's nav menu (PioneerOverlayWindow.Overlay_OnClick's ContextMenu)
/// sits over Pioneer — a SEPARATE process — so a plain WPF ContextMenu's
/// own close-on-outside-click handling can't be relied on for a click that
/// lands on Pioneer's own window. PioneerOverlayWindow instead installs a
/// global WH_MOUSE_LL hook (see its OnGlobalMouseDown) while the menu is
/// open, and closes the menu on any mouse-down whose SCREEN point falls
/// outside the menu's own on-screen bounds — including a click on Pioneer
/// itself, or anywhere else on the desktop.
///
/// This is the PURE geometry half of that check (no Win32/WPF dependency
/// of its own — same "positioning/geometry math lives in a pure static
/// helper" split OverlayPlacement.cs already uses), so it's directly
/// unit-testable with plain int/OverlayRect values — see
/// OverlayMenuGeometryTests.cs.
/// </summary>
public static class OverlayMenuGeometry
{
    /// <summary>
    /// True when the screen point (x, y) — physical pixels, the same
    /// coordinate space MSLLHOOKSTRUCT.pt reports — falls OUTSIDE
    /// `menuBounds` (also physical pixels: the menu's own PointToScreen
    /// origin plus its rendered size). A point on the left/top edge counts
    /// as inside; a point on the right/bottom edge counts as outside —
    /// standard half-open rectangle convention, so adjacent, non-overlapping
    /// menus/regions never both claim the exact same boundary pixel.
    /// </summary>
    public static bool IsPointOutsideMenu(OverlayRect menuBounds, int x, int y)
    {
        var insideX = x >= menuBounds.X && x < menuBounds.X + menuBounds.Width;
        var insideY = y >= menuBounds.Y && y < menuBounds.Y + menuBounds.Height;
        return !(insideX && insideY);
    }
}
