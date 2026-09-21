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
}
