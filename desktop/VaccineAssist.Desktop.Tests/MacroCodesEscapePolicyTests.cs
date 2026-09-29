using VaccineAssist.Desktop.Views;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// MacroCodesEscapePolicy itself needs no WPF Window (see its own doc
/// comment), so it's covered here by fast xUnit tests, same "pure half"
/// split as MacroCodesWindowSizingTests. Covers the Escape-while-armed
/// bug fix (Will, 2026-09-28, verbatim): "pushing Esc closes the whole
/// app window. Instead, make it clear back to the full list of macro
/// codes, then esc again closes the app window." — and the V-T64 follow-up
/// (Will, 2026-09-29, verbatim: "Escape is still closing the full window,
/// not backing out of Shingrix") that dropped the WebView.IsKeyboardFocusWithin
/// gate entirely: it was an unreliable proxy (WPF's own focus bookkeeping
/// for the WebView2 HwndHost, not the browser's real focus state) that
/// could read false while the page was genuinely focused and handling
/// every other hotkey correctly, causing exactly this bug. Once the page
/// has loaded, it is the sole owner of Escape — the pageReady flag is the
/// only input this policy takes now.
/// </summary>
public class MacroCodesEscapePolicyTests
{
    [Fact]
    public void ShouldCloseImmediately_IsFalse_WhenPageIsReady()
    {
        // The normal case once the popup has finished loading: let the
        // page's own Escape handling run (clear armed dose / post
        // macro-cancel) instead of closing the window out from under it.
        // No longer gated on any WPF-reported focus flag — see the class
        // doc comment for why that flag was the V-T64 bug.
        var result = MacroCodesEscapePolicy.ShouldCloseImmediately(pageReady: true);

        Assert.False(result);
    }

    [Fact]
    public void ShouldCloseImmediately_IsTrue_WhenPageIsNotReady()
    {
        // Navigation hasn't finished (or failed) yet — the page's keydown
        // listener isn't guaranteed to exist, so Escape must still close
        // the window directly rather than doing nothing. This is the
        // ONLY case that still closes immediately.
        var result = MacroCodesEscapePolicy.ShouldCloseImmediately(pageReady: false);

        Assert.True(result);
    }
}
