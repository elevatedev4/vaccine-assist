using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
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

    /// <summary>
    /// REVIEWER FIX (REQUEST_CHANGES, V-T41 R6 round 2): the original
    /// version waited up to 2s PER CANDIDATE — up to 4 Origin + 3 Days
    /// Supply = 7 candidates = ~14s added to EVERY entry whenever nothing
    /// matches, which is exactly the common case today (neither field's
    /// AutomationId is confirmed — see OriginAndDaysSupplyFieldCandidates'
    /// own doc comment) and directly fights Will's own same-round ask to
    /// "make it more efficient and speed it up." Replaced with ONE shared
    /// budget for the WHOLE step (both fields together, not 3s each) — see
    /// ExecuteAsync's Stopwatch and TrySetFieldAsync's remaining-budget
    /// checks.
    /// </summary>
    private static readonly TimeSpan TotalTimeBudget = TimeSpan.FromSeconds(3);

    /// <summary>Per-candidate cap WITHIN the shared budget above — only
    /// spent on a candidate id TrySetFieldAsync's own single field-snapshot
    /// already showed actually exists (see that method's doc comment), so
    /// this is a short confirmation wait, not a blind poll for something
    /// that might not be there at all.</summary>
    private static readonly TimeSpan PerCandidateWaitCap = TimeSpan.FromMilliseconds(400);

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
        var stopwatch = Stopwatch.StartNew();

        var originOutcome = await TrySetFieldAsync(
            context, window, "origin", OriginValue,
            OriginAndDaysSupplyFieldCandidates.OriginAutomationIds,
            OriginAndDaysSupplyFieldCandidates.TryMatchOrigin,
            OriginAndDaysSupplyReadback.OriginMatches,
            stopwatch, cancellationToken);

        var daysSupplyOutcome = await TrySetFieldAsync(
            context, window, "days supply", DaysSupplyValue,
            OriginAndDaysSupplyFieldCandidates.DaysSupplyAutomationIds,
            OriginAndDaysSupplyFieldCandidates.TryMatchDaysSupply,
            OriginAndDaysSupplyReadback.DaysSupplyMatches,
            stopwatch, cancellationToken);

        // REVIEWER FIX: "Log the total time the step spent."
        context.Log($"[{Name}] finished in {stopwatch.ElapsedMilliseconds}ms (shared {TotalTimeBudget.TotalSeconds:0}s budget for both fields).");

        var message = $"Origin — {originOutcome.Message} Days supply — {daysSupplyOutcome.Message}";
        return new PioneerEntryStepResult(Name, Success: true, DryRun: false, message);
    }

    /// <summary>
    /// REVIEWER FIX (REQUEST_CHANGES, V-T41 R6 round 2) — reworked to spend
    /// at most `TotalTimeBudget` (3s, shared with the OTHER field's call —
    /// `stopwatch` is the same instance both calls share) instead of the
    /// old up-to-2s-per-candidate design:
    /// 1. Bails out immediately (no UIA calls at all) if the shared budget
    ///    is already spent — e.g. the origin field's own search used it
    ///    all up.
    /// 2. Takes exactly ONE EditableFieldDumper snapshot of `window` (not
    ///    one per candidate) — this is a single enumeration, not a poll, so
    ///    it costs one UIA tree walk, not time.
    /// 3. Filters `candidateIds` down to just the ones that snapshot
    ///    actually shows present+enabled — a candidate id that isn't even
    ///    IN the snapshot gets NO wait at all, since EditableFieldDumper
    ///    only collects already-enabled fields (skip the fixed-candidate
    ///    waits entirely when none of the ids exist, per the reviewer's
    ///    note).
    /// 4. Only for ids that DID show up in the snapshot, does a short
    ///    (PerCandidateWaitCap, further capped by whatever's left of the
    ///    shared budget) confirmation wait via QuickSearchFieldEntry.
    ///    WaitForFieldAsync — first one confirmed wins.
    /// 5. If still nothing (and budget remains), runs `keywordMatcher`
    ///    against the SAME already-collected snapshot — no second UIA
    ///    enumeration.
    /// 6. If STILL nothing matches, logs the dump (AutomationId/ClassName/
    ///    ControlType/bounds only, per Will's brief) and returns a
    ///    non-fatal "couldn't find it" outcome — Success stays true; the
    ///    caller folds this into the step's own always-successful result.
    /// 7. Once a field IS found (by either path), sets it via the same
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
        Stopwatch stopwatch,
        CancellationToken cancellationToken)
    {
        if (stopwatch.Elapsed >= TotalTimeBudget)
        {
            context.Log($"[{Name}] out of the step's shared {TotalTimeBudget.TotalSeconds:0}s time budget before checking {fieldLabel} — not checked.");
            return new QuickSearchFieldEntry.Outcome(true,
                $"skipped the {fieldLabel} field — the step's shared time budget was already spent on the other field. Rest of the entry continues.");
        }

        var snapshot = EditableFieldDumper.Collect(window);
        var presentCandidateIds = candidateIds
            .Where(id => snapshot.Any(f => string.Equals(f.AutomationId, id, StringComparison.OrdinalIgnoreCase)))
            .ToList();

        string? usedId = null;
        var matchKind = "known AutomationId";

        if (presentCandidateIds.Count > 0)
        {
            usedId = await TryFixedCandidateAsync(window, presentCandidateIds, stopwatch, cancellationToken);
        }

        if (usedId is null)
        {
            var keywordMatch = stopwatch.Elapsed < TotalTimeBudget ? keywordMatcher(snapshot) : null;
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
                context.Log($"[{Name}] couldn't find the {fieldLabel} field (tried {candidateIds.Count} known AutomationId(s), " +
                    $"{presentCandidateIds.Count} present in the field snapshot, and a keyword fallback) — enabled fields: " +
                    $"{EditableFieldDumper.DescribeForLog(snapshot)}");
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

    /// <summary>Only called with ids the caller's own snapshot already
    /// showed present+enabled — each gets at most PerCandidateWaitCap
    /// (400ms), further capped by whatever's left of the STEP's shared
    /// `stopwatch`/`TotalTimeBudget` (both fields draw from the same
    /// clock). Stops trying further candidates the instant the shared
    /// budget is gone, even mid-list.</summary>
    private static async Task<string?> TryFixedCandidateAsync(
        AutomationElement window, IReadOnlyList<string> candidateIds, Stopwatch stopwatch, CancellationToken cancellationToken)
    {
        foreach (var id in candidateIds)
        {
            var remaining = TotalTimeBudget - stopwatch.Elapsed;
            if (remaining <= TimeSpan.Zero) return null;

            var wait = remaining < PerCandidateWaitCap ? remaining : PerCandidateWaitCap;
            var found = await QuickSearchFieldEntry.WaitForFieldAsync(window, id, wait, log: null, cancellationToken: cancellationToken);
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
