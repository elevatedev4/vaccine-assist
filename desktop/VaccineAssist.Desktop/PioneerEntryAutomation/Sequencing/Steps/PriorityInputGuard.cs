using System;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// V-T41 ROUND 4 REVIEW FIX (BLOCKER 1 — safety reviewer): "after
/// TryBringToForeground there is NO re-check; Alt+Down is then sent blind.
/// If the focus switch silently failed, Alt+Down lands on Pioneer's main
/// New Rx form." This is the PURE decision half of the fix — the ONE rule
/// every raw keystroke/click the Priority strategies send must pass
/// IMMEDIATELY beforehand (see
/// SendF3AndDismissPreEntryDialogsStep.TryAuthorizeDialogInput for the live
/// wrapper that gathers these three booleans fresh, right before each
/// send, and calls this). Pure — no UIA/Win32 dependency of its own — so
/// the decision itself is directly unit-testable; see
/// PriorityInputGuardTests.cs.
///
/// `foregroundIsSameProcessComboLBoxPopup` exists because a combo's own
/// expanded drop-down (a separate top-level 'ComboLBox' window — see
/// ComboLBoxWindowLocator) LEGITIMATELY steals foreground from the dialog
/// while it's open; refusing all input the instant the dialog itself isn't
/// literally the foreground window would make it impossible to ever click
/// an item inside that popup. This is the ONLY other window ever accepted
/// as "safe to send to" — anything else (Pioneer's own main window, an
/// unrelated app) refuses.
/// </summary>
public static class PriorityInputGuard
{
    public static bool CanSendInput(bool dialogAliveAndVisible, bool dialogIsForeground, bool foregroundIsSameProcessComboLBoxPopup)
    {
        if (!dialogAliveAndVisible) return false;
        return dialogIsForeground || foregroundIsSameProcessComboLBoxPopup;
    }

    /// <summary>
    /// V-T41 ROUND 5 (Will's 2026-09-29 follow-up: F12 still doesn't save
    /// the Priority dialog): the ComboLBox-popup allowance above exists
    /// ONLY for input that legitimately targets the combo's own
    /// drop-down (Alt+Down to open it, a click/type-ahead inside it) —
    /// see CanSendInput's own doc comment. A Save/confirm keystroke
    /// (F12, Enter, Alt+O) is never meant for that popup; PioneerRx's
    /// ComboLBox list simply ignores F12, which is exactly why it "does
    /// nothing" — the OLD single guard let the F12 send through anyway
    /// as long as SOME same-process ComboLBox popup was foreground,
    /// whether or not it had actually been closed after the value was
    /// set. This is the STRICT sibling used for every confirm-step send
    /// (see SendF3AndDismissPreEntryDialogsStep.TryAuthorizeConfirmInput):
    /// the dialog itself must be the literal foreground window — no
    /// popup exception — so a confirm keystroke is only ever sent once
    /// the dropdown has actually been closed and the dialog has regained
    /// focus.
    /// </summary>
    public static bool CanConfirmDialog(bool dialogAliveAndVisible, bool dialogIsForeground)
    {
        return dialogAliveAndVisible && dialogIsForeground;
    }

    /// <summary>
    /// V-T41 ROUND 6 (Will's 2026-09-29 11:14 app.log, this round): the
    /// window-class list every "is this popup safe to send to / safe to
    /// Escape-close before confirming" check in
    /// SendF3AndDismissPreEntryDialogsStep (TryAuthorizeDialogInput,
    /// TryAuthorizeConfirmInput, EnsureDropdownClosedAndDialogForeground)
    /// shares — centralized here (rather than each call site re-listing
    /// class names) so the set stays in exactly one place. Previously only
    /// 'ComboLBox' (a classic Win32 combo's own drop-down list window) was
    /// recognized; the decisive log's own UIA dump proved PioneerRx's real
    /// Priority dialog control is an Edit search box (AutomationId
    /// 'uxPrioritySearch') with its OWN separate top-level popup window,
    /// class 'Auto-Suggest Dropdown' (Pioneer's autocomplete popup — see
    /// DialogClassifier.IsTransientWindowClass, which already treats this
    /// same class as never-a-real-dialog for the UNRELATED "should this
    /// window ever be ESC'd as a stray pre-entry dialog" question this
    /// guard doesn't answer). Case-insensitive; null/empty is never a
    /// match.
    /// </summary>
    private static readonly string[] RecognizedPopupWindowClasses = { "ComboLBox", "Auto-Suggest Dropdown" };

    public static bool IsRecognizedPopupWindowClass(string? windowClass) =>
        !string.IsNullOrEmpty(windowClass) &&
        Array.Exists(RecognizedPopupWindowClasses, c => string.Equals(c, windowClass, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// V-T41 ROUND 7 REVIEW FIX (BLOCKING — reviewer, this round): a
    /// SEPARATE, narrow allowance — NOT a relaxation of CanConfirmDialog's
    /// general invariant above, which stays exactly as strict as ROUND 5
    /// left it for every other confirm-step call site (Enter-on-button,
    /// Enter-on-dialog, Alt+O, and the Escape-fallback retry of F12
    /// itself). This one exists for exactly one situation: the
    /// macro-fidelity strategy (TryKeyboardNoDropdownStrategy) just typed
    /// the value into the dialog THIS SAME call, and Pioneer's own
    /// Auto-Suggest Dropdown (or a legacy ComboLBox) popped up as a
    /// DIRECT, EXPECTED result of that typing. Will's macro is: type,
    /// then F12, nothing else — it never Escapes the popup first. ROUND 6
    /// had this call EnsureDropdownClosedAndDialogForeground
    /// (Escape-the-popup-then-reassert) UNCONDITIONALLY before the first
    /// F12 attempt, reversing the macro's own order whenever the popup
    /// was foreground right after typing — a WinForms autocomplete Escape
    /// commonly cancels the pending/highlighted suggestion, exactly the
    /// "F12 sent, dialog stays open" failure shape already seen twice.
    /// `typedThisCall` is an explicit CALLER-ASSERTED precondition, never
    /// inferred here — the caller (TryConfirmWithF12BeforeEscapingOwnPopup)
    /// only ever passes true when it is itself being invoked immediately
    /// after that same strategy's own typing, so this can't be
    /// accidentally reused to authorize a stale/unrelated popup. Returns
    /// false outright when `!typedThisCall`, so this can never become a
    /// second, looser version of CanConfirmDialog by accident.
    /// </summary>
    public static bool CanConfirmAfterOwnTyping(bool dialogAliveAndVisible, bool dialogIsForeground, bool popupForegroundIsRecognizedSameProcess, bool typedThisCall)
    {
        if (!dialogAliveAndVisible || !typedThisCall) return false;
        return dialogIsForeground || popupForegroundIsRecognizedSameProcess;
    }
}
