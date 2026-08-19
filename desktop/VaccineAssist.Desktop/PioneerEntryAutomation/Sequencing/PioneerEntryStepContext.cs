using System;
using FlaUI.Core.AutomationElements;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;

/// <summary>
/// Everything a single IPioneerEntryStep needs to run. Shared, mutable
/// across the whole sequence run (steps hand information forward — e.g.
/// FocusPioneerWindowStep resolves AttachedWindow, later steps use it)
/// rather than each step re-resolving state independently.
/// </summary>
public sealed class PioneerEntryStepContext
{
    public PioneerEntryStepContext(VaccineEntryPayload payload, bool dryRun, Action<string> log)
    {
        Payload = payload;
        DryRun = dryRun;
        Log = log;
    }

    public VaccineEntryPayload Payload { get; }

    /// <summary>
    /// True = log what each step WOULD do and stop before any UIA call —
    /// "for testing on machines without Pioneer" (V-T3 item 4). Every step
    /// checks this FIRST, before touching AttachedWindow/FlaUI at all, so
    /// dry-run is safe to use even with no PioneerRx installed.
    /// </summary>
    public bool DryRun { get; }

    /// <summary>Per-step log sink — DataEntryPopupViewModel wires this to a visible step log, not just a file (V-T3 item 3: "per-step logging").</summary>
    public Action<string> Log { get; }

    /// <summary>Set by FocusPioneerWindowStep once attached; null until then (and always null in dry-run, since that step never attaches for real).</summary>
    public AutomationElement? AttachedWindow { get; set; }
}
