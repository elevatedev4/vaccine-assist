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

            var stepStopwatch = Stopwatch.StartNew();
            PioneerEntryStepResult result;
            try
            {
                result = await step.ExecuteAsync(context, cancellationToken);
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

            results.Add(result);

            if (!result.Success)
            {
                break;
            }
        }

        return new PioneerEntrySequenceResult(results);
    }
}
