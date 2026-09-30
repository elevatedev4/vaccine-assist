using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;

/// <summary>
/// Pure orchestration behind running an IPioneerEntrySequence — no
/// FlaUI/UIA/Windows dependency at all, so it's covered by fast xUnit
/// tests using fake IPioneerEntryStep implementations instead of only a
/// manual trace (same reasoning as rx-verify's Uia/RetryingFieldRead.cs).
///
/// Algorithm: run each step in Sequence.Steps IN ORDER, logging a
/// start/finish line for each (context.Log — V-T3 item 3's "per-step
/// logging"). The FIRST failed step stops the run — later steps do not
/// run (fail-fast: a data-entry sequence where step 2 failed to type the
/// vaccine code has no business attempting step 3's lot/expiration entry
/// into whatever field currently has focus). An unexpected exception from
/// a step (one that didn't follow IPioneerEntryStep's "return a failed
/// result, don't throw" contract) is still caught here and turned into a
/// failed result, so one misbehaving step can never crash the whole run —
/// EXCEPT an OperationCanceledException caused by `cancellationToken`
/// itself (RunOneStepAsync), which is deliberately RE-thrown rather than
/// turned into a step failure: a step cancelled mid-execution (e.g. the
/// Ctrl+Keypad 7 overlay's X button firing while a field-wait poll loop is
/// running) must surface to the caller the same way a between-steps
/// cancellation already does, not be reported as an ordinary failed step.
/// </summary>
public static class PioneerEntrySequenceRunner
{
    public static async Task<PioneerEntrySequenceResult> RunAsync(
        IPioneerEntrySequence sequence,
        PioneerEntryStepContext context,
        CancellationToken cancellationToken = default)
    {
        var results = new List<PioneerEntryStepResult>();

        foreach (var step in sequence.Steps)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var result = await RunOneStepAsync(step, context, cancellationToken);
            results.Add(result);

            if (!result.Success)
            {
                break;
            }
        }

        return new PioneerEntrySequenceResult(results);
    }

    /// <summary>
    /// V-T41 item 5 ("Step mode" toggle, Will's 2026-09-22 brief): runs
    /// EXACTLY ONE step of `sequence` — the one at `stepIndex` — instead of
    /// the whole sequence, so the Ctrl+Keypad7 popup can single-step
    /// through the macro one click at a time with the log line shown
    /// inline, to see exactly where a live run diverges from
    /// desktop/docs/data-entry-macro.md. Reuses the exact same
    /// start/OK/FAILED logging (via RunOneStepAsync below) RunAsync uses,
    /// so a step-mode log line reads identically to the same step's line in
    /// a normal full run — and the SAME context (AttachedWindow, etc.)
    /// carries forward between calls, since the caller is expected to keep
    /// reusing one PioneerEntryStepContext across successive
    /// RunSingleStepAsync calls (one per click) rather than rebuilding it
    /// each time.
    /// </summary>
    public static async Task<PioneerEntrySingleStepResult> RunSingleStepAsync(
        IPioneerEntrySequence sequence,
        PioneerEntryStepContext context,
        int stepIndex,
        CancellationToken cancellationToken = default)
    {
        if (stepIndex < 0 || stepIndex >= sequence.Steps.Count)
        {
            throw new ArgumentOutOfRangeException(nameof(stepIndex), stepIndex,
                $"Step index must be between 0 and {sequence.Steps.Count - 1}.");
        }

        var step = sequence.Steps[stepIndex];
        var result = await RunOneStepAsync(step, context, cancellationToken);
        var isLastStep = stepIndex == sequence.Steps.Count - 1;

        return new PioneerEntrySingleStepResult(result, stepIndex, sequence.Steps.Count, isLastStep);
    }

    /// <summary>
    /// One step's start/execute/log cycle — shared by RunAsync (the whole
    /// sequence, back to back) and RunSingleStepAsync (Step mode, one call
    /// per click) so both produce byte-identical log lines for the same
    /// step. See RunAsync's own doc comment for the algorithm this
    /// implements (fail-fast, never let a misbehaving step throw out of
    /// the runner).
    /// </summary>
    private static async Task<PioneerEntryStepResult> RunOneStepAsync(
        IPioneerEntryStep step, PioneerEntryStepContext context, CancellationToken cancellationToken)
    {
        context.Log($"[{step.Name}] starting{(context.DryRun ? " (dry run)" : "")}...");

        var stepStopwatch = Stopwatch.StartNew();
        PioneerEntryStepResult result;
        try
        {
            result = await step.ExecuteAsync(context, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // REVIEWER FIX (REQUEST_CHANGES, V-T41 R5): a step's own poll
            // loop (QuickSearchFieldEntry.WaitForFieldAsync/TypeAndConfirmAsync's
            // Task.Delay(interval, cancellationToken)) throws
            // OperationCanceledException the instant the caller's
            // CancellationTokenSource is cancelled (the overlay's X button,
            // mid-step) — the blanket catch below used to swallow this into
            // a normal "FAILED — Unexpected error: The operation was
            // canceled." step result, letting RunAsync return NORMALLY
            // (no exception) instead of surfacing the cancellation. Callers
            // (MainWindow.RunVaccineEntryAutomationAsync) had to fall back
            // to checking cancellationToken.IsCancellationRequested AFTER a
            // normal return to notice this at all. Rethrowing here — the
            // `when` guard only fires for a cancellation that genuinely
            // came from OUR OWN token, never an unrelated
            // OperationCanceledException a step might throw for its own
            // reasons — means a mid-step cancel now surfaces identically to
            // RunAsync's own between-steps cancellationToken.ThrowIfCancellationRequested()
            // check: both propagate an OperationCanceledException straight
            // out of RunAsync/RunSingleStepAsync, no further steps run, and
            // no step is ever reported as merely "FAILED" for a cancellation
            // the user asked for. See PioneerEntrySequenceRunnerTests.
            // CancellingMidStepThrowsInsteadOfBeingSwallowedAsAFailure.
            context.Log($"[{step.Name}] cancelled by user mid-step.");
            throw;
        }
        catch (Exception ex)
        {
            result = new PioneerEntryStepResult(step.Name, Success: false, context.DryRun, $"Unexpected error: {ex.Message}");
        }

        // V-..., 2026-09-11 ("Show where time goes" — Will's feedback
        // that the delay between steps felt bigger than it should):
        // every OK line now carries how long the step actually took,
        // UNLESS the step's own message already reports timing itself
        // (e.g. QuickSearchFieldEntry.WaitForFieldCoreAsync's "waited
        // Nms for 'x' to appear") — appending a second, redundant
        // elapsed figure there would just be noise. FAILED lines are
        // left as-is; a failure's own message (field-not-found dumps,
        // stalled-retry summaries, etc.) already names what happened,
        // and the log line right above already shows how long the
        // failing attempt ran before this line prints.
        var okMessage = result.Success && !result.Message.Contains("(took ", StringComparison.OrdinalIgnoreCase)
            ? $"{result.Message} (took {stepStopwatch.ElapsedMilliseconds}ms)"
            : result.Message;

        context.Log(result.Success
            ? $"[{result.StepName}] OK — {okMessage}"
            : $"[{result.StepName}] FAILED — {result.Message}");

        return result;
    }
}

/// <summary>One RunSingleStepAsync call's outcome — see that method's own
/// doc comment. StepIndex/TotalSteps/IsLastStep let the caller (the
/// Ctrl+Keypad7 popup's Step mode UI) show "Step 3/8: ..." and disable the
/// "Run next step" button once IsLastStep's step has run.</summary>
public readonly record struct PioneerEntrySingleStepResult(
    PioneerEntryStepResult Result, int StepIndex, int TotalSteps, bool IsLastStep);
