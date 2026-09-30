using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using FlaUI.Core.AutomationElements;
using VaccineAssist.Desktop.Uia;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// Types the vaccine's directions/sig into PioneerRx's "Add New Rx"
/// directions field — Will's brief (2026-09-07): "did not yet enter the
/// quantity, directions, lot, or expiration."
///
/// FIELD TARGET: uxDirections — NOT CONFIRMED against a live UIA dump
/// (unlike uxQuantityPrescribed, uxPrescriberQuickSearch,
/// uxPrescribedItemQuickSearch, uxLotNumber, uxLotExpirationDate, and
/// uxSave, all of which the 2026-09-05 dumps confirmed — see
/// PioneerEntryAutomation/TODO.md). This is a PLACEHOLDER AutomationId —
/// no directions/sig field appeared in any of the six dumps collected so
/// far, likely because none of those captures got far enough into the
/// form to show it.
///
/// CANDIDATE SEARCH (V-T41 R5, Will 2026-09-29 8:15pm: quantity now
/// enters fine, but "[Enter directions] FAILED — Couldn't find the
/// directions field (AutomationId 'uxDirections')" after ~59s — the
/// single hardcoded id above was exactly this doc comment's own
/// UNCONFIRMED warning coming true live): rather than betting the whole
/// step on one guessed AutomationId, FindAndTypeDirectionsAsync below now
/// tries DirectionsFieldCandidates.AutomationIds in order (uxDirections
/// first, so a correct guess costs nothing extra), each with a short 2s
/// wait inside the overall 15s budget (QuickSearchFieldEntry.
/// DefaultFieldWaitTimeout) rather than 15s per candidate, searched under
/// BOTH context.AttachedWindow and the current OS foreground window when
/// it's a DIFFERENT PioneerRx window (Uia/ForegroundPioneerWindow). If no
/// fixed id matches, a keyword fallback (DirectionsFieldCandidates.
/// TryMatch, Name/AutomationId containing "direction" or "sig") gets one
/// try against whatever's actually enabled on screen. If NOTHING matches,
/// one compact, NO-PHI field dump (Uia/EditableFieldDumper — AutomationId/
/// Name/ClassName/ControlType/bounds, never field values) is logged
/// before the step fails, so the next report names exactly what candidate
/// AutomationId round 6 should hardcode. Whichever candidate DOES match
/// is logged by name — see FindAndTypeDirectionsAsync.
///
/// NULL/BLANK DIRECTIONS — REWORKED (V-..., 2026-09-10, Will 2026-09-09/10:
/// entry "stopped at quantity"): every vaccine row currently has blank
/// Directions on file, so — same root cause as InputQuantityStep's own
/// rework — the OLD "skip silently" behavior below was invisible, not
/// correct. Now prompts (PioneerEntryStepContext.RequestTextPrompt) instead
/// of skipping, with THREE outcomes instead of Quantity's two:
///   - Continue: types whatever was entered AND saves it back onto the
///     vaccine's catalog record (PioneerEntryStepContext.SaveDirectionsAsync)
///     so the next run has it on file.
///   - Skip: leaves Pioneer's directions field untouched and moves on —
///     Will's brief, verbatim: "some workflows fill SIG later." Nothing
///     saved back either (there's nothing new to save).
///   - Cancel: aborts the whole entry with a named reason.
/// </summary>
public sealed class InputDirectionsStep : IPioneerEntryStep
{
    public const string DirectionsAutomationId = "uxDirections";

    public string Name => "Enter directions";

    public async Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
    {
        var directions = context.Payload.Directions;

        if (string.IsNullOrWhiteSpace(directions))
        {
            var prompt = RequestDirections(context);
            switch (prompt.Action)
            {
                case TextPromptAction.Cancel:
                    return new PioneerEntryStepResult(Name, Success: false, DryRun: context.DryRun,
                        "Cancelled — no directions on file for this vaccine and the directions prompt was cancelled. Entry stopped.");
                case TextPromptAction.Skip:
                    return new PioneerEntryStepResult(Name, Success: true, DryRun: context.DryRun,
                        "Skipped — staff chose to leave directions blank for now (some workflows fill SIG later). Nothing typed into Pioneer.");
                case TextPromptAction.Continue:
                default:
                    directions = prompt.Value;
                    await SaveDirectionsBackToVaccineAsync(context, directions);
                    break;
            }
        }

        if (context.DryRun)
        {
            return new PioneerEntryStepResult(Name, Success: true, DryRun: true,
                $"Would type directions \"{directions}\" into '{DirectionsAutomationId}' (UNCONFIRMED AutomationId — no PioneerRx call made).");
        }

        if (context.AttachedWindow is null)
        {
            return new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                "No PioneerRx window attached — FocusPioneerWindowStep must run (and succeed) before this step.");
        }

        return await FindAndTypeDirectionsAsync(context, directions!, cancellationToken);
    }

    /// <summary>
    /// V-T41 R5: the candidate-list search described in this class's own
    /// doc comment. Returns as soon as ANY candidate (fixed id or keyword
    /// fallback) is found, typed, and confirmed; logs which one matched.
    /// Logs one compact field dump and returns a named failure if nothing
    /// matches within QuickSearchFieldEntry.DefaultFieldWaitTimeout (15s
    /// total, not 15s per candidate).
    /// </summary>
    private async Task<PioneerEntryStepResult> FindAndTypeDirectionsAsync(
        PioneerEntryStepContext context, string directions, CancellationToken cancellationToken)
    {
        var attachedWindow = context.AttachedWindow!;
        var searchWindows = BuildSearchWindows(attachedWindow);

        var fixedMatch = await TryFixedCandidatesAsync(searchWindows, cancellationToken);
        if (fixedMatch is { } found)
        {
            context.Log($"[{Name}] matched candidate AutomationId '{found.CandidateId}'{found.Label}.");
            var outcome = await QuickSearchFieldEntry.TypeAndConfirmAsync(
                found.Window, found.CandidateId, "directions", directions, enterPresses: 0,
                log: context.Log, cancellationToken: cancellationToken);
            return new PioneerEntryStepResult(Name, outcome.Success, DryRun: false, outcome.Message);
        }

        // Keyword fallback, then (whether or not it matches) the one
        // compact dump — see this class's own doc comment.
        var allFields = new List<FieldDescriptor>();
        foreach (var (window, label) in searchWindows)
        {
            var fields = EditableFieldDumper.Collect(window);
            allFields.AddRange(fields);

            var match = DirectionsFieldCandidates.TryMatch(fields);
            if (match is { } m && !string.IsNullOrEmpty(m.AutomationId))
            {
                var matchedId = m.AutomationId!;
                context.Log($"[{Name}] matched by keyword: AutomationId '{matchedId}' Name '{m.Name ?? ""}'{label}.");
                var outcome = await QuickSearchFieldEntry.TypeAndConfirmAsync(
                    window, matchedId, "directions", directions, enterPresses: 0,
                    log: context.Log, cancellationToken: cancellationToken);
                return new PioneerEntryStepResult(Name, outcome.Success, DryRun: false, outcome.Message);
            }
        }

        context.Log($"[{Name}] no directions/sig field candidate matched — enabled fields: {EditableFieldDumper.DescribeForLog(allFields)}");
        return new PioneerEntryStepResult(Name, Success: false, DryRun: false,
            $"Couldn't find the directions field after trying {DirectionsFieldCandidates.AutomationIds.Count} candidate AutomationId(s) " +
            "and a keyword fallback on the attached PioneerRx window" +
            (searchWindows.Count > 1 ? " and the foreground PioneerRx window" : "") +
            " — see the field dump logged just above.");
    }

    /// <summary>Tries DirectionsFieldCandidates.AutomationIds in order, each
    /// with a short (2s) wait against every search window, inside the
    /// OVERALL 15s budget (QuickSearchFieldEntry.DefaultFieldWaitTimeout) —
    /// not 15s per candidate. Returns as soon as one is found+enabled;
    /// null if the whole budget is spent with nothing found.</summary>
    private static async Task<(AutomationElement Window, string CandidateId, string Label)?> TryFixedCandidatesAsync(
        List<(AutomationElement Window, string Label)> searchWindows, CancellationToken cancellationToken)
    {
        var totalBudget = QuickSearchFieldEntry.DefaultFieldWaitTimeout;
        var perCandidateWait = TimeSpan.FromSeconds(2);
        var stopwatch = Stopwatch.StartNew();

        foreach (var candidateId in DirectionsFieldCandidates.AutomationIds)
        {
            foreach (var (window, label) in searchWindows)
            {
                var remaining = totalBudget - stopwatch.Elapsed;
                if (remaining <= TimeSpan.Zero) return null;

                var wait = remaining < perCandidateWait ? remaining : perCandidateWait;
                var found = await QuickSearchFieldEntry.WaitForFieldAsync(window, candidateId, wait, log: null, cancellationToken: cancellationToken);
                if (found) return (window, candidateId, label);
            }
        }

        return null;
    }

    /// <summary>The attached window, PLUS the current OS foreground window
    /// when it's a DIFFERENT PioneerRx window (Uia/ForegroundPioneerWindow)
    /// — see this class's own doc comment. `label` is a short, human
    /// readable suffix for the "matched candidate ..." log line (blank for
    /// the attached window, since that's the normal/expected case).</summary>
    private static List<(AutomationElement Window, string Label)> BuildSearchWindows(AutomationElement attachedWindow)
    {
        var result = new List<(AutomationElement Window, string Label)> { (attachedWindow, "") };

        IntPtr attachedHandle;
        try { attachedHandle = attachedWindow.FrameworkAutomationElement.NativeWindowHandle ?? IntPtr.Zero; }
        catch { attachedHandle = IntPtr.Zero; }

        var foreground = ForegroundPioneerWindow.TryGetIfDifferent(attachedHandle);
        if (foreground is not null)
        {
            result.Add((foreground, " on the foreground PioneerRx window"));
        }

        return result;
    }

    /// <summary>Shows the blank-directions prompt with Skip offered — see
    /// PioneerEntryStepContext.RequestTextPrompt's own doc comment for the
    /// "fails closed to Cancel when unwired" posture. Shown regardless of
    /// DryRun — see InputQuantityStep.RequestQuantity's identical
    /// reasoning.</summary>
    private static TextPromptResult RequestDirections(PioneerEntryStepContext context)
    {
        if (context.RequestTextPrompt is null) return TextPromptResult.Cancelled;

        var vaccineName = string.IsNullOrWhiteSpace(context.Payload.VaccineName) ? "this vaccine" : context.Payload.VaccineName;
        return context.RequestTextPrompt(
            $"Directions (SIG) for {vaccineName}",
            "No directions are on file for this vaccine. Enter directions/SIG, or Skip to leave it blank for now:",
            true);
    }

    /// <summary>Saves directions the prompt above just collected back onto
    /// the vaccine's catalog record — a FAILED save must not abort the
    /// entry (same posture as InputQuantityStep.SaveQuantityBackToVaccineAsync),
    /// so this only ever logs the outcome.</summary>
    private async Task SaveDirectionsBackToVaccineAsync(PioneerEntryStepContext context, string directions)
    {
        if (context.SaveDirectionsAsync is null) return;

        try
        {
            var saved = await context.SaveDirectionsAsync(directions);
            context.Log(saved
                ? $"[{Name}] Saved directions \"{directions}\" back onto the vaccine catalog record."
                : $"[{Name}] Couldn't save directions \"{directions}\" back onto the vaccine catalog record — continuing with entry anyway.");
        }
        catch (Exception ex)
        {
            context.Log($"[{Name}] Couldn't save directions \"{directions}\" back onto the vaccine catalog record: {ex.Message} — continuing with entry anyway.");
        }
    }
}
