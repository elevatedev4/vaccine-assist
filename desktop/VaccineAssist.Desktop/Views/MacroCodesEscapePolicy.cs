namespace VaccineAssist.Desktop.Views;

/// <summary>
/// Pure decision for MacroCodesWindow_OnPreviewKeyDown's Escape handling
/// (Will, 2026-09-28, verbatim): "When selecting dose for Shingrix,
/// Engerix, etc, pushing Esc closes the whole app window. Instead, make
/// it clear back to the full list of macro codes, then esc again closes
/// the app window."
///
/// The window-level PreviewKeyDown handler used to Close() on every
/// Escape unconditionally (brief step 3 from the original build: "on ...
/// the window's own Escape (PreviewKeyDown) just close" — kept as a
/// fallback here, not removed), which fires before the embedded page's
/// own document keydown listener ever sees the key. But the page
/// (cloud/lib/macro-hotkeys.ts hotkeyTransition + app/macro-codes/page.tsx)
/// already has the right semantics: Escape while a multi-dose vaccine
/// (Shingrix, Engerix, etc.) is armed clears back to the full list and
/// posts nothing; Escape while nothing is armed posts
/// "vaccine-assist:macro-cancel", which MacroCodesWindow's own
/// CoreWebView2_OnWebMessageReceived closes the window for. So the fix is
/// to let the page own Escape whenever it safely can, and only fall back
/// to closing here when the page can't be trusted to have handled it.
///
/// "Safely can" means: the page has actually finished loading (so its
/// keydown listener is wired up — MacroCodesWindow.xaml.cs sets
/// _pageReady from CoreWebView2_OnNavigationCompleted's e.IsSuccess) AND
/// the WebView control currently has keyboard focus (so the keypress is
/// actually reaching the page's document rather than, say, some other
/// control or the window chrome). If either is false — page never
/// loaded, navigation failed and the FailurePanel is showing, or focus
/// is somehow not in the WebView — Escape must still close the window
/// immediately, exactly as before, so the pharmacist is never stuck with
/// a popup no key can dismiss.
/// </summary>
public static class MacroCodesEscapePolicy
{
    /// <summary>True when MacroCodesWindow_OnPreviewKeyDown should
    /// Close() the window itself on Escape. False means: do nothing and
    /// let the keypress continue on to the WebView2 page, which will
    /// either clear the armed dose (first Escape) or post
    /// "vaccine-assist:macro-cancel" (second Escape, which the existing
    /// web-message handler closes the window for).</summary>
    public static bool ShouldCloseImmediately(bool pageReady, bool webViewHasKeyboardFocus)
    {
        return !(pageReady && webViewHasKeyboardFocus);
    }
}
