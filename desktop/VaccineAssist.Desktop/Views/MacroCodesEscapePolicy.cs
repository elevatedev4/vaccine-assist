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
/// own document keydown listener ever sees the key — WPF's HwndHost
/// interop treats Escape as one of the "accelerator"/dialog-navigation
/// keys that get offered to the ancestor Window's PreviewKeyDown via
/// TranslateAccelerator BEFORE the native WebView2 child ever receives
/// it, regardless of who currently "has focus" in any UI sense. But the
/// page (cloud/lib/macro-hotkeys.ts hotkeyTransition + app/macro-codes/
/// page.tsx) already has the right semantics: Escape while a multi-dose
/// vaccine (Shingrix, Engerix, etc.) is armed clears back to the full
/// list and posts nothing; Escape while nothing is armed posts
/// "vaccine-assist:macro-cancel", which MacroCodesWindow's own
/// CoreWebView2_OnWebMessageReceived closes the window for. So the fix is
/// to let the page own Escape whenever it safely can, and only fall back
/// to closing here when the page can't be trusted to have handled it.
///
/// V-T64 (Will, 2026-09-29, verbatim): "Escape is still closing the full
/// window, not backing out of Shingrix" — this policy used to ALSO
/// require WebView.IsKeyboardFocusWithin before letting the page own
/// Escape (see git history). That flag tracks WPF's own keyboard-focus
/// bookkeeping for the WebView2 HwndHost, which is a DIFFERENT thing
/// from "the browser content will actually receive this keystroke": this
/// app's own FocusWebView() only ever calls the WPF-level WebView.Focus()
/// / Keyboard.Focus(WebView) (see MacroCodesWindow.xaml.cs) — it never
/// calls CoreWebView2Controller.MoveFocus(...), the API WebView2 itself
/// exposes to keep the native/browser focus state in sync after a
/// programmatic .NET-level focus call. So IsKeyboardFocusWithin can read
/// false at the exact moment the page is genuinely focused and correctly
/// handling every other hotkey (S arms Shingrix, digits pick a dose) —
/// exactly the reported symptom, and exactly the case the OLD
/// `ShouldCloseImmediately_IsTrue_WhenWebViewDoesNotHaveKeyboardFocus`
/// test pinned down as "focus is somewhere else", an assumption that
/// doesn't hold here. Trusting it as a gate was the bug.
///
/// Now "safely can" means only: the page has actually finished loading
/// (so its keydown listener is wired up — MacroCodesWindow.xaml.cs sets
/// _pageReady from CoreWebView2_OnNavigationCompleted's e.IsSuccess). If
/// that's false — page never loaded, or navigation failed and the
/// FailurePanel is showing — Escape must still close the window
/// immediately, exactly as before, so the pharmacist is never stuck with
/// a popup no key can dismiss. Once the page IS ready, this window never
/// independently closes on Escape again; it only closes on the page's
/// own "vaccine-assist:macro-cancel" message (CoreWebView2_OnWebMessageReceived)
/// or the window chrome. Exactly one component decides what Escape does.
/// </summary>
public static class MacroCodesEscapePolicy
{
    /// <summary>True when MacroCodesWindow_OnPreviewKeyDown should
    /// Close() the window itself on Escape. False means: do nothing and
    /// let the keypress continue on to the WebView2 page, which will
    /// either clear the armed dose (first Escape) or post
    /// "vaccine-assist:macro-cancel" (second Escape, which the existing
    /// web-message handler closes the window for).</summary>
    public static bool ShouldCloseImmediately(bool pageReady)
    {
        return !pageReady;
    }
}
