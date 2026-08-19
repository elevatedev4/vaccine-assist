using System.Threading;
using System.Threading.Tasks;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;

/// <summary>
/// One step of a PioneerRx data-entry sequence (focus window / navigate
/// fields / input a value / confirm — V-T3 item 3). Implementations must
/// never throw for an EXPECTED failure (not-yet-wired field targets,
/// window not found, etc.) — return a failed PioneerEntryStepResult
/// instead, so PioneerEntrySequenceRunner's step log stays accurate. An
/// UNEXPECTED exception is still caught by the runner (belt and braces)
/// but won't carry a step-specific message.
/// </summary>
public interface IPioneerEntryStep
{
    /// <summary>Short, stable name shown in the step log and asserted on in sequence-planning tests.</summary>
    string Name { get; }

    Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default);
}
