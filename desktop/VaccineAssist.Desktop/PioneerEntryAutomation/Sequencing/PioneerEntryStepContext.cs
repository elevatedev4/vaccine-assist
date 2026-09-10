using System;
using System.Threading.Tasks;
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

    /// <summary>
    /// V-... 2026-09-10 (Will, 2026-09-09/10: desktop data entry "made it
    /// through to quantity (slowly) and stopped at quantity (not
    /// entered)" — every vaccine row currently has a blank Quantity/
    /// Directions on file, and the old InputQuantityStep/InputDirectionsStep
    /// silently skipped typing anything when that was blank instead of
    /// asking): shows a focused prompt for the missing value — used by
    /// those two steps when Payload.Quantity/Directions is blank. Same
    /// popup-focus mechanics as VarUpdateConfirmationWindow (owned by the
    /// data-entry popup window, ShowDialog, so it comes to the front over
    /// PioneerRx) — wired by DataEntryPopupWindow's constructor onto
    /// DataEntryPopupViewModel.RequestTextPromptRequested, which
    /// EnterIntoPioneerAsync forwards onto this context when it builds
    /// it. FAILS CLOSED like ConfirmVarUpdateRequested: null (unwired —
    /// e.g. a test that isn't exercising this gate) is treated as Cancel
    /// by the steps below, never as "type nothing and move on." Args:
    /// title (e.g. "Quantity needed for Comirnaty 2025-26 12+"), message
    /// (what the box is for), allowSkip (Directions only — see
    /// TextPromptAction.Skip's own doc comment).
    /// </summary>
    public Func<string, string, bool, TextPromptResult>? RequestTextPrompt { get; set; }

    /// <summary>Persists the quantity a RequestTextPrompt prompt just
    /// collected back onto the vaccine's catalog record via PATCH
    /// /api/vaccines/{id} (so the next run has it on file and never has
    /// to ask again) — wired by DataEntryPopupViewModel, closed over the
    /// selected vaccine's id. Null (unwired) just skips the save
    /// silently; a save that runs and FAILS must not abort the entry
    /// either (Will's brief) — InputQuantityStep logs either outcome and
    /// keeps going regardless.</summary>
    public Func<string, Task<bool>>? SaveQuantityAsync { get; set; }

    /// <summary>Same as SaveQuantityAsync, for Directions.</summary>
    public Func<string, Task<bool>>? SaveDirectionsAsync { get; set; }
}
