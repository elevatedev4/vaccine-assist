using VaccineAssist.Desktop.Views;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// MacroCodesEscapePolicy itself needs no WPF Window (see its own doc
/// comment), so it's covered here by fast xUnit tests, same "pure half"
/// split as MacroCodesWindowSizingTests. Covers the Escape-while-armed
/// bug fix (Will, 2026-09-28, verbatim): "pushing Esc closes the whole
/// app window. Instead, make it clear back to the full list of macro
/// codes, then esc again closes the app window."
/// </summary>
public class MacroCodesEscapePolicyTests
{
    [Fact]
    public void ShouldCloseImmediately_IsFalse_WhenPageIsReadyAndWebViewHasFocus()
    {
        // The normal case once the popup has finished loading and the
        // pharmacist is interacting with it: let the page's own Escape
        // handling run (clear armed dose / post macro-cancel) instead of
        // closing the window out from under it.
        var result = MacroCodesEscapePolicy.ShouldCloseImmediately(pageReady: true, webViewHasKeyboardFocus: true);

        Assert.False(result);
    }

    [Fact]
    public void ShouldCloseImmediately_IsTrue_WhenPageIsNotReady()
    {
        // Navigation hasn't finished (or failed) yet — the page's keydown
        // listener isn't guaranteed to exist, so Escape must still close
        // the window directly rather than doing nothing.
        var result = MacroCodesEscapePolicy.ShouldCloseImmediately(pageReady: false, webViewHasKeyboardFocus: true);

        Assert.True(result);
    }

    [Fact]
    public void ShouldCloseImmediately_IsTrue_WhenWebViewDoesNotHaveKeyboardFocus()
    {
        // The page is loaded but focus is somewhere else (e.g. the
        // window chrome) — the keypress won't reach the page's document,
        // so falling through would leave Escape doing nothing at all.
        var result = MacroCodesEscapePolicy.ShouldCloseImmediately(pageReady: true, webViewHasKeyboardFocus: false);

        Assert.True(result);
    }

    [Fact]
    public void ShouldCloseImmediately_IsTrue_WhenNeitherPageIsReadyNorWebViewHasFocus()
    {
        // e.g. the WebView2 init itself failed and the FailurePanel is
        // showing — Escape must never leave the pharmacist stuck with an
        // un-closeable popup.
        var result = MacroCodesEscapePolicy.ShouldCloseImmediately(pageReady: false, webViewHasKeyboardFocus: false);

        Assert.True(result);
    }
}
