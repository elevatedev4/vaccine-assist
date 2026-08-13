using System;
using System.Threading;
using System.Threading.Tasks;

namespace VaccineAssist.Desktop.PioneerEntryAutomation;

/// <summary>
/// Phase-1 stub: no live PioneerRx wiring yet (there's no PioneerRx
/// instance to test against from here, and no live UIA tree dump to
/// work from — see TODO.md). TryAttachAsync always reports "not found"
/// so callers cleanly fall back to the Entry screen's clipboard-payload
/// flow instead of erroring.
/// </summary>
public sealed class PioneerEntryAutomationStub : IPioneerEntryAutomation
{
    public bool IsAttached => false;

    public Task<bool> TryAttachAsync(CancellationToken cancellationToken = default) => Task.FromResult(false);

    public Task EnterVaccineAsync(VaccineEntryPayload payload, CancellationToken cancellationToken = default)
    {
        throw new NotImplementedException(
            "PioneerEntryAutomation is not wired up yet (phase 1 stub) — see " +
            "PioneerEntryAutomation/TODO.md. Use the Entry screen's clipboard payload instead.");
    }
}
