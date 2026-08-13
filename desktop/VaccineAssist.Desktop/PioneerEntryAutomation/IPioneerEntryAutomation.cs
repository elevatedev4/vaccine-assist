using System.Threading;
using System.Threading.Tasks;

namespace VaccineAssist.Desktop.PioneerEntryAutomation;

/// <summary>
/// Replaces vaccine-add-new.mxe: drives PioneerRx's vaccine
/// administration form directly instead of a Macro Express script. See
/// TODO.md — real wiring happens live on the owner's machine once a
/// PioneerRx UIA tree dump is available to work from (same approach
/// rx-verify's Uia/PioneerRxWindow.cs used for its own PioneerRx
/// automation).
/// </summary>
public interface IPioneerEntryAutomation
{
    /// <summary>True once a PioneerRx window with an open Rx Profile /
    /// vaccine administration form has been found and attached to.</summary>
    bool IsAttached { get; }

    /// <summary>Attempts to find and attach to the active PioneerRx window.
    /// Returns false (never throws) when no matching window is found —
    /// callers fall back to the clipboard-payload flow in that case.</summary>
    Task<bool> TryAttachAsync(CancellationToken cancellationToken = default);

    /// <summary>Types the given payload into the attached PioneerRx window.
    /// Throws if IsAttached is false — call TryAttachAsync first.</summary>
    Task EnterVaccineAsync(VaccineEntryPayload payload, CancellationToken cancellationToken = default);
}
