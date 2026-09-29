namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>Outcome of one tick of PriorityForegroundWaitPolicy.Decide — see
/// that method's own doc comment.</summary>
public enum PriorityForegroundWaitDecision
{
    /// <summary>The dialog is foreground AND (when a specific control was
    /// being waited for) that control is the UIA-focused element — safe to
    /// type/act now.</summary>
    Type,

    /// <summary>Not there yet, but the wait budget isn't exhausted —
    /// sleep one tick and re-check.</summary>
    KeepWaiting,

    /// <summary>The wait budget is exhausted and the condition still isn't
    /// met — stop waiting; the caller logs the actual foreground state and
    /// proceeds anyway (TryAuthorizeDialogInput/TryAuthorizeConfirmInput
    /// are the real send-time gates).</summary>
    GiveUp,
}

/// <summary>
/// V-T41 ROUND 6 (Will's 2026-09-29 11:14 app.log): the PURE decision half
/// of SendF3AndDismissPreEntryDialogsStep.WaitForDialogForegroundAndFocus's
/// polling loop — that morning's log showed the macro-fidelity strategy's
/// OLD one-shot foreground check (checked once, 74ms after the dialog was
/// found, no retry) refuse immediately instead of actively waiting for
/// PioneerRx to actually hand over foreground/focus. Given the two
/// booleans gathered fresh on each tick (is the dialog the OS foreground
/// window right now? is the UIA-focused element the control this call is
/// about to type into?) and how many ticks have elapsed against the wait
/// budget, decides whether to act now (Type), poll again (KeepWaiting), or
/// stop waiting and let the caller fall through with a logged timeout
/// (GiveUp) — rather than either blocking forever or giving up after a
/// single unretried check. No UIA/Win32 dependency of its own — directly
/// unit-testable; see PriorityForegroundWaitPolicyTests.cs. The live
/// wrapper (WaitForDialogForegroundAndFocus) gathers the two booleans via
/// Win32WindowEnumerator.IsForegroundWindow / the UIA-focused element's own
/// AutomationId on each tick and calls this.
/// </summary>
public static class PriorityForegroundWaitPolicy
{
    public static PriorityForegroundWaitDecision Decide(bool foregroundIsDialog, bool focusedIsTarget, int elapsedTicks, int maxTicks)
    {
        if (foregroundIsDialog && focusedIsTarget)
        {
            return PriorityForegroundWaitDecision.Type;
        }

        return elapsedTicks >= maxTicks ? PriorityForegroundWaitDecision.GiveUp : PriorityForegroundWaitDecision.KeepWaiting;
    }
}
