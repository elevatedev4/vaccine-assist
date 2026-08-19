using System;
using System.Collections.Generic;
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
/// failed result, so one misbehaving step can never crash the whole run.
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

            context.Log($"[{step.Name}] starting{(context.DryRun ? " (dry run)" : "")}...");

            PioneerEntryStepResult result;
            try
            {
                result = await step.ExecuteAsync(context, cancellationToken);
            }
            catch (Exception ex)
            {
                result = new PioneerEntryStepResult(step.Name, Success: false, context.DryRun, $"Unexpected error: {ex.Message}");
            }

            context.Log(result.Success
                ? $"[{result.StepName}] OK — {result.Message}"
                : $"[{result.StepName}] FAILED — {result.Message}");

            results.Add(result);

            if (!result.Success)
            {
                break;
            }
        }

        return new PioneerEntrySequenceResult(results);
    }
}
