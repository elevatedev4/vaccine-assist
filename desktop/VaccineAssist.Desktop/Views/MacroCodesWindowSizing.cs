using System;

namespace VaccineAssist.Desktop.Views;

/// <summary>
/// Pure size math for MacroCodesWindow's macro-popup round 3 (Will's
/// verbatim ask, 2026-09-25): "Make it wider so that it will display
/// bigger, and make the height fit only what it needs to be able to
/// show everything, not extra space at the bottom." Kept separate from
/// the real WPF Window (same "pure half" split as
/// AgeMacroCodesUrlBuilder/AgePromptInput) so the width/height/centering
/// arithmetic below is covered by fast xUnit tests with no WPF
/// dependency — see MacroCodesWindowSizingTests.
///
/// MacroCodesWindow.xaml.cs is the only caller: it supplies the live
/// SystemParameters.WorkArea values and the window's own measured
/// non-WebView chrome height (title bar + borders — this window has no
/// XAML header/footer elements of its own, so "chrome" here just means
/// the difference between the outer Window and the WebView2 control's
/// client area), and applies the results to Width/Height/Left/Top.
/// </summary>
public static class MacroCodesWindowSizing
{
    /// <summary>
    /// Window height shown before the very first
    /// "vaccine-assist:content-size" message arrives from the page (see
    /// MacroCodesWindow.xaml.cs's CoreWebView2_OnWebMessageReceived) —
    /// per the brief, a modest starting height so the window never
    /// flashes tall then shrinks down to the real content size.
    /// </summary>
    public const double InitialHeight = 600;

    /// <summary>Never resizes the window shorter than this, even for a
    /// tiny reported content height (e.g. a transient empty/loading
    /// state) — the brief's own example value.</summary>
    public const double MinHeight = 300;

    /// <summary>Small slack added on top of content height + chrome
    /// height so the very last pixel of content is never clipped by
    /// rounding/subpixel differences between what the page measured and
    /// what WebView2 actually renders — the brief's "+ a few px slack."</summary>
    public const double HeightSlackPx = 8;

    /// <summary>Work-area margin kept clear on every side, matching the
    /// existing 40px margin the constructor already used for its
    /// pre-round-3 Width/Height clamp.</summary>
    public const double WorkAreaMarginPx = 40;

    /// <summary>
    /// Target window width (brief step 1): as wide as the work area
    /// allows, up to 1700px, leaving an 80px margin so the window never
    /// touches the screen edges.
    /// </summary>
    public static double ComputeWidth(double workAreaWidth)
    {
        return Math.Min(1700, Math.Max(0, workAreaWidth - 80));
    }

    /// <summary>
    /// Desired window height for a reported content height (CSS px from
    /// the page's "vaccine-assist:content-size" message — see that
    /// message's own doc comment in lib/macro-embed.ts for why this is
    /// the same unit as a WPF DIP here), the window's own measured
    /// non-WebView chrome height, and the screen's usable height.
    /// Clamped to [MinHeight, workAreaHeight - WorkAreaMarginPx] so the
    /// window never exceeds the visible desktop on a smaller monitor,
    /// even for a very tall catalog — the page itself falls back to
    /// scrolling inside whatever height that clamp leaves it (see
    /// app/macro-codes/page.tsx's round-3 doc comment: "do not hide
    /// overflow").
    /// </summary>
    public static double ComputeHeight(double contentHeightPx, double chromeHeightPx, double workAreaHeight)
    {
        var desired = Math.Max(0, contentHeightPx) + Math.Max(0, chromeHeightPx) + HeightSlackPx;
        var max = Math.Max(MinHeight, workAreaHeight - WorkAreaMarginPx);
        return Math.Clamp(desired, MinHeight, max);
    }

    /// <summary>
    /// Centers a window of the given size within the work area.
    /// WindowStartupLocation="CenterScreen" only applies on the window's
    /// first Show — every content-driven resize after that (this
    /// window's ResizeMode is NoResize, so nothing else ever moves or
    /// resizes it) needs this done by hand, per the brief.
    /// </summary>
    public static (double Left, double Top) ComputeCenteredPosition(
        double windowWidth,
        double windowHeight,
        double workAreaLeft,
        double workAreaTop,
        double workAreaWidth,
        double workAreaHeight)
    {
        var left = workAreaLeft + (workAreaWidth - windowWidth) / 2;
        var top = workAreaTop + (workAreaHeight - windowHeight) / 2;
        return (left, top);
    }
}
