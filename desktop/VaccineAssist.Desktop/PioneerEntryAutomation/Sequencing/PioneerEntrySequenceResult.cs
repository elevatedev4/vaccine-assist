using System.Collections.Generic;
using System.Linq;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;

/// <summary>Aggregate outcome of running every step in an IPioneerEntrySequence — see PioneerEntrySequenceRunner.</summary>
public sealed record PioneerEntrySequenceResult(IReadOnlyList<PioneerEntryStepResult> StepResults)
{
    /// <summary>True only if every step that ran succeeded (a sequence stopped early by a failed step is never Success).</summary>
    public bool Success => StepResults.Count > 0 && StepResults.All(r => r.Success);

    /// <summary>The first failed step, or null if every step succeeded (or none ran).</summary>
    public PioneerEntryStepResult? FirstFailure => StepResults.FirstOrDefault(r => !r.Success);
}
