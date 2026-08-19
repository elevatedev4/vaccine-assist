using System.Collections.Generic;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;

/// <summary>
/// A named, ordered sequence of PioneerRx data-entry steps (V-T3 item 3:
/// "an IPioneerEntrySequence abstraction... executed via FlaUI UIA with
/// per-step logging + a dry-run mode"). Exposing Steps as a plain,
/// inspectable list — not just a single opaque RunAsync — is what makes
/// "sequence-step planning" testable without touching FlaUI/UIA at all:
/// a test can assert on Steps' names/order/count directly. Wiring the
/// REAL Pioneer field sequence later (once vaccine-add-new.mxe is
/// available) means implementing a new IPioneerEntrySequence (or editing
/// PlaceholderVaccineEntrySequence's step list) — a data/config change,
/// not a rebuild of any calling code, since callers only depend on this
/// interface + PioneerEntrySequenceRunner.
/// </summary>
public interface IPioneerEntrySequence
{
    /// <summary>Shown in the popup's step log header.</summary>
    string Name { get; }

    IReadOnlyList<IPioneerEntryStep> Steps { get; }
}
