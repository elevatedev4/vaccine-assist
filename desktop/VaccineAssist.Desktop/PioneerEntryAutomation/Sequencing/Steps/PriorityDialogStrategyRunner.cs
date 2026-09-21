using System;
using System.Collections.Generic;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>Outcome of one Priority-dialog resolution strategy — see
/// PriorityDialogStrategyRunner's own doc comment. `Resolved` means the
/// strategy acted AND the dialog was VERIFIED gone afterward (never
/// declared just because an action was attempted — see
/// SendF3AndDismissPreEntryDialogsStep.VerifyDialogGone); `StillOpen` means
/// the strategy found something to act on and acted, but the dialog is
/// still there; `NotFound` means the strategy found nothing it could even
/// attempt (e.g. no selection control at all).</summary>
public enum PriorityStrategyOutcome
{
    Resolved,
    StillOpen,
    NotFound,
}

/// <summary>One named Priority-resolution strategy — `Run` performs the
/// strategy's own act-then-verify-closed work and returns the outcome.
/// Pure from PriorityDialogStrategyRunner's point of view; the delegate
/// itself is free to do live UIA/Win32 work (see
/// SendF3AndDismissPreEntryDialogsStep.TryUiaSelectStrategy/
/// TryKeyboardStrategy).</summary>
public readonly record struct PriorityStrategyStep(string Name, Func<PriorityStrategyOutcome> Run);

/// <summary>
/// V-T41 ROUND 4 (Will's 2026-09-21 brief, point 1+2): "make 'OK' mean
/// VERIFIED ... If still present, log FAILED-still-open and move to the
/// next strategy rather than re-running the same one next tick" —
/// previously this step re-ran the SAME "type + Enter" action every single
/// combined-loop tick (~every 1.1-1.2s) because a "handled" return was
/// logged the instant an action was ATTEMPTED, never checked against
/// whether the dialog actually closed; the real 2026-09-21 log shows that
/// exact shape (the Priority dialog handled ~25 times over ~26s, never
/// once verified closed). This is the fix's PURE sequencing half: run each
/// strategy in `strategies`, in order, stopping at the first one whose own
/// act-then-verify returns Resolved. Every strategy tried is reported via
/// `log` (1-based index, total count, name, outcome) so the log is
/// conclusive about exactly which strategies were tried and how each one
/// ended. A strategy that THROWS is treated as StillOpen (never crashes
/// the whole resolution — same "best effort, describe don't crash"
/// posture as every other UIA scan in this codebase) rather than
/// propagating and skipping the remaining strategies/the final dump.
/// </summary>
public static class PriorityDialogStrategyRunner
{
    public static string? Run(IReadOnlyList<PriorityStrategyStep> strategies, Action<int, int, string, PriorityStrategyOutcome> log)
    {
        for (var i = 0; i < strategies.Count; i++)
        {
            var step = strategies[i];
            PriorityStrategyOutcome outcome;
            try
            {
                outcome = step.Run();
            }
            catch
            {
                outcome = PriorityStrategyOutcome.StillOpen;
            }

            log(i + 1, strategies.Count, step.Name, outcome);

            if (outcome == PriorityStrategyOutcome.Resolved)
            {
                return step.Name;
            }
        }
        return null;
    }
}

/// <summary>
/// PURE synchronous polling primitive — used by
/// SendF3AndDismissPreEntryDialogsStep.VerifyDialogGone to wait up to ~1.5s
/// for a dialog HWND to actually disappear before a strategy is allowed to
/// claim "OK." Synchronous (not the Task-based WaitForAsync elsewhere in
/// this step) because every other call in Priority-dialog handling
/// (Keyboard.Type, Mouse.LeftClick, UIA pattern invokes) is itself
/// synchronous — this step's combined loop is the only async layer, and
/// looping a single "tick" of it just to wait ~1.5s for one dialog would
/// spread a single logical wait across many outer ticks for no benefit.
/// `sleepOneTick` is injected so tests can fake it (count calls, no real
/// delay) instead of a live Thread.Sleep.
/// </summary>
public static class SynchronousPoll
{
    public static bool WaitUntil(Func<bool> condition, int maxTicks, Action sleepOneTick)
    {
        for (var i = 0; i < maxTicks; i++)
        {
            if (condition()) return true;
            sleepOneTick();
        }
        return condition();
    }
}

/// <summary>Thrown when every Priority-dialog resolution strategy has been
/// tried (and, per point (d) of the brief, a redacted raw UIA dump has
/// already been logged) and the dialog is STILL open — caught in
/// ExecuteAsync to fail the whole step loud with a message telling the
/// user to pick "Vaccine" manually, rather than looping or silently moving
/// on with the dialog still blocking data entry.</summary>
public sealed class PriorityDialogUnresolvedException : Exception
{
    public PriorityDialogUnresolvedException(string message) : base(message)
    {
    }
}
