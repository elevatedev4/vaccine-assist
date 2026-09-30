using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using FlaUI.Core.AutomationElements;
using VaccineAssist.Desktop.Uia;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// Sets PioneerRx's Origin field to "Other" and its Days Supply field to
/// "1" — V-T41 R6 (Will's answer, 2026-09-30 1:11pm, verbatim): "Origin
/// needs to be set to Other and Days supply needs to be set to 1." Runs
/// LAST among the field-entry steps, after InputLotAndExpirationStep
/// (Will's own "Then we just need to..." — i.e. once everything else is
/// already on the screen) and before ConfirmEntryStep — see
/// PlaceholderVaccineEntrySequence's step order doc comment.
///
/// NEITHER FIELD TARGET IS FULLY CONFIRMED against a live UIA dump the way
/// uxLotNumber/uxQuantityPrescribed/uxPrescribedItemQuickSearch are — see
/// OriginAndDaysSupplyFieldCandidates' own doc comment for exactly what IS
/// and isn't confirmed for each of the two fields. Per Will's brief
/// (item 1): "if either field cannot be located, log the editable-field
/// dump ... and continue without failing the whole entry, with a clear log
/// line naming which field was missing." This step follows that literally:
/// TrySetFieldAsync below NEVER returns a hard failure for "couldn't find
/// it" or "found it but PioneerRx wouldn't accept the value" — both are
/// logged (with a one-line EditableFieldDumper dump — AutomationId/
/// ClassName/ControlType/bounds only, no values, see that class's own
/// PHI note) and folded into this step's own SUCCESSFUL result message, so
/// PioneerEntrySequenceRunner always proceeds to ConfirmEntryStep
/// regardless of whether either of these two optional fields actually took.
/// The only hard failure this step can return is "no PioneerRx window
/// attached" — the same precondition every other live step in this
/// sequence enforces.
/// </summary>
public sealed class InputOriginAndDaysSupplyStep : IPioneerEntryStep
{
    public const string OriginValue = "Other";
    public const string DaysSupplyValue = "1";

    /// <summary>Short per-candidate existence check, not a long poll — by
    /// the time this step runs, InputVaccineCodeStep/InputQuantityStep/
    /// InputDirectionsStep/InputLotAndExpirationStep have all already
    /// succeeded, so the Add New Rx screen is already fully rendered
    /// (unlike the earlier fields, which needed QuickSearchFieldEntry.
    /// DefaultFieldWaitTimeout's full 15s budget to survive the screen
    /// still loading). Kept short deliberately — Will's own follow-up ask
    /// this same round was "make it more efficient and speed it up," so
    /// this step doesn't add a new long wait while that's pending.</summary>
    private static readonly TimeSpan PerCandidateWait = TimeSpan.FromSeconds(2);

    public string Name => "Set origin and days supply";

    public async Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
    {
        if (context.DryRun)
        {
            return new PioneerEntryStepResult(Name, Success: true, DryRun: true,
                $"Would set origin to \"{OriginValue}\" and days supply to \"{DaysSupplyValue}\" " +
                "(AutomationId not yet confirmed for either field — no PioneerRx call made).");
        }

        if (context.AttachedWindow is null)
        {
            return new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                "No PioneerRx window attached — FocusPioneerWindowStep must run (and succeed) before this step.");
        }

        var window = context.AttachedWindow;

        var originOutcome = await TrySetFieldAsync(
            context, window, "origin", OriginValue,
            OriginAndDaysSupplyFieldCandidates.OriginAutomationIds,
            OriginAndDaysSupplyFieldCandidates.TryMatchOrigin,
            OriginAndDaysSupplyReadback.OriginMatches,
            cancellationToken);

        var daysSupplyOutcome = await TrySetFieldAsync(
            context, window, "days supply", DaysSupplyValue,
            OriginAndDaysSupplyFieldCandidates.DaysSupplyAutomationIds,
            OriginAndDaysSupplyFieldCandidates.TryMatchDaysSupply,
            OriginAndDaysSupplyReadback.DaysSupplyMatches,
            cancellationToken);

        var message = $"Origin — {originOutcome.Message} Days supply — {daysSupplyOutcome.Message}";
        return new PioneerEntryStepResult(Name, Success: true, DryRun: false, message);
    }

    /// <summary>
    /// 1. Tries every id in `candidateIds`, in order, with a short
    ///    existence check each (PerCandidateWait) — first one found wins.
    /// 2. If none of the fixed ids are found, collects a fresh
    ///    EditableFieldDumper snapshot and runs `keywordMatcher` against it
    ///    (same "keyword fallback over whatever's actually enabled"
    ///    strategy as InputDirectionsStep.FindAndTypeDirectionsAsync).
    /// 3. If STILL nothing matches, logs the dump (AutomationId/ClassName/
    ///    ControlType/bounds only, per Will's brief) and returns a
    ///    non-fatal "couldn't find it" outcome — Success stays true; the
    ///    caller folds this into the step's own always-successful result.
    /// 4. Once a field IS found (by either path), sets it via the same
    ///    QuickSearchFieldEntry.TypeAndConfirmAsync every other field-entry
    ///    step uses, then reads it back (`readbackMatches`) and logs a
    ///    warning — never a failure — on a mismatch.
    /// Never throws; every branch returns a QuickSearchFieldEntry.Outcome
    /// with Success reflecting "trust this as done" rather than "the whole
    /// step should fail."
    /// </summary>
    private async Task<QuickSearchFieldEntry.Outcome> TrySetFieldAsync(
        PioneerEntryStepContext context,
        AutomationElement window,
        string fieldLabel,
        string value,
        IReadOnlyList<string> candidateIds,
        Func<IReadOnlyList<FieldDescriptor>, FieldDescriptor?> keywordMatcher,
        Func<string?, string, bool> readbackMatches,
        CancellationToken cancellationToken)
    {
        var usedId = await TryFixedCandidateAsync(window, candidateIds, cancellationToken);
        var matchKind = "known AutomationId";

        if (usedId is null)
        {
            var fields = EditableFieldDumper.Collect(window);
            var keywordMatch = keywordMatcher(fields);
            if (keywordMatch is { } m && !string.IsNullOrEmpty(m.AutomationId))
            {
                // Null-forgiving per InputDirectionsStep.FindAndTypeDirectionsAsync's
                // identical "var matchedId = m.AutomationId!;" — already checked
                // non-blank just above.
                usedId = m.AutomationId!;
                matchKind = "keyword match";
            }
            else
            {
                context.Log($"[{Name}] couldn't find the {fieldLabel} field (tried {candidateIds.Count} known AutomationId(s) and a keyword " +
                    $"fallback) — enabled fields: {EditableFieldDumper.DescribeForLog(fields)}");
                return new QuickSearchFieldEntry.Outcome(true,
                    $"couldn't find the {fieldLabel} field on the attached PioneerRx window — see the field dump just logged. Not set; rest of the entry continues.");
            }
        }

        context.Log($"[{Name}] setting {fieldLabel} via {matchKind} '{usedId}'.");
        var outcome = await QuickSearchFieldEntry.TypeAndConfirmAsync(
            window, usedId!, fieldLabel, value, enterPresses: 0, log: context.Log, cancellationToken: cancellationToken);

        if (!outcome.Success)
        {
            context.Log($"[{Name}] found the {fieldLabel} field (AutomationId '{usedId}') but couldn't set it: {outcome.Message}");
            return new QuickSearchFieldEntry.Outcome(true,
                $"found the {fieldLabel} field (AutomationId '{usedId}') but couldn't set it — see the log line just above. Rest of the entry continues.");
        }

        var readback = TryReadField(window, usedId!);
        if (!readbackMatches(readback, value))
        {
            context.Log($"[{Name}] set {fieldLabel} (AutomationId '{usedId}') to \"{value}\", but reading it back shows a different value — " +
                "PioneerRx may have rejected or reformatted it.");
            return new QuickSearchFieldEntry.Outcome(true,
                $"set the {fieldLabel} field (AutomationId '{usedId}') to \"{value}\", but the readback didn't match — check it manually.");
        }

        return new QuickSearchFieldEntry.Outcome(true,
            $"set the {fieldLabel} field (AutomationId '{usedId}') to \"{value}\" (read back and verified).");
    }

    private static async Task<string?> TryFixedCandidateAsync(
        AutomationElement window, IReadOnlyList<string> candidateIds, CancellationToken cancellationToken)
    {
        foreach (var id in candidateIds)
        {
            var found = await QuickSearchFieldEntry.WaitForFieldAsync(window, id, PerCandidateWait, log: null, cancellationToken: cancellationToken);
            if (found) return id;
        }
        return null;
    }

    /// <summary>Same read-back idiom as InputLotAndExpirationStep.VerifyFieldTyped
    /// (`Patterns.Value.Pattern.Value.ValueOrDefault`) — best-effort, never
    /// throws, returns null on any failure to re-find/read the field.</summary>
    private static string? TryReadField(AutomationElement window, string automationId)
    {
        try
        {
            var field = window.FindFirstDescendant(cf => cf.ByAutomationId(automationId));
            if (field is null) return null;
            return field.Patterns.Value.Pattern.Value.ValueOrDefault;
        }
        catch
        {
            return null;
        }
    }
}
