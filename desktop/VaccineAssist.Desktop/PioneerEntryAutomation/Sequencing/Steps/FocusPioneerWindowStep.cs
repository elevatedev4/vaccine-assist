using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Uia;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// Step 1 of PlaceholderVaccineEntrySequence: find + attach to the
/// PioneerRx window via UIA (PioneerRxAttachment — see that file's doc
/// for the title caveat). This step is REAL, not a placeholder — focusing
/// the window doesn't depend on knowing the vaccine entry form's exact
/// field layout, unlike the steps after it.
///
/// TIMING (V-..., 2026-09-10 — Will's real app.log: this step took 20s on
/// a live run). INVESTIGATED: unlike SendF3AndDismissPreEntryDialogsStep,
/// this step has no fixed sleep/retry loop of its own to cut —
/// PioneerRxAttachment.TryAttach() is a single synchronous UIA desktop
/// scan (one UIA3Automation + FindAllChildren() walk) with nothing else
/// in between. The most likely explanation is the same root cause
/// SendF3's own SPEED REWORK found: that one scan is genuinely slow
/// against a live PioneerRx process (real cross-process COM work), not a
/// coded wait. There was previously no visibility into how long the scan
/// itself takes — a slow "OK — Attached to PioneerRx window." line looked
/// identical to a fast one. Now wraps the call in a Stopwatch and reports
/// the elapsed time in both the success and failure messages, so the next
/// real report shows a number instead of requiring a guess.
/// </summary>
public sealed class FocusPioneerWindowStep : IPioneerEntryStep
{
    public string Name => "Focus PioneerRx window";

    public Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
    {
        if (context.DryRun)
        {
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: true, DryRun: true,
                "Would locate and focus the PioneerRx window (no PioneerRx call made)."));
        }

        var stopwatch = Stopwatch.StartNew();
        var window = PioneerRxAttachment.TryAttach();
        stopwatch.Stop();

        if (window is null)
        {
            // PioneerRxAttachment already logged which top-level windows
            // it DID see (titles/classes, no PHI) to AppFileLog — the
            // popup's "Copy logs" button (V-T3 item 4) grabs that for
            // sending back, without needing a live UIA dump session.
            return Task.FromResult(new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                $"No PioneerRx window found after a {stopwatch.ElapsedMilliseconds}ms scan — open the patient's Rx profile " +
                "before entering data. Use \"Copy logs\" to send the list of windows that WERE detected."));
        }

        context.AttachedWindow = window;
        return Task.FromResult(new PioneerEntryStepResult(Name, Success: true, DryRun: false,
            $"Attached to PioneerRx window (scan took {stopwatch.ElapsedMilliseconds}ms)."));
    }
}
