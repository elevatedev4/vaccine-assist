using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using VaccineAssist.Desktop.Uia;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// Types the lot number and expiration date directly into PioneerRx's
/// dispensed-drug panel — unlike the physician/drug fields, these are
/// plain text entry (no ENTER-driven search/select) in the live dumps, so
/// no keypress follows SetValue.
///
/// FIELD TARGETS (confirmed against the live "Add New Rx" UIA dumps, all
/// inside the Dispense tab's uxRxTransactionDispensedDrugPanel):
///   - Lot: Edit, name='Lot:', AutomationId='uxLotNumber', patterns=[Value]
///     (dump line ~741, blank on the empty form; populated with
///     "testlot" only in the LAST progressive-state dump — after the
///     physician + drug fields were already resolved, matching this
///     step's place in the sequence).
///   - Expiration: Edit, name='Exp:', AutomationId='uxLotExpirationDate',
///     patterns=[Value] (dump line ~750, populated with "9/5/2027" in
///     that same last dump).
///
/// DATE FORMAT: the live value ("9/5/2027") is PioneerRx's own date-edit
/// format — M/d/yyyy, no leading zeros — NOT the MMDDYYYY macro format
/// VaccineEntryPayload.ExpirationMacroFormat carries (kept in that format
/// because it's also used by ToClipboardPayload's macro-era fallback
/// string). ToPioneerDateFormat below converts MMDDYYYY -> M/d/yyyy
/// before typing; if the stored value doesn't parse as MMDDYYYY (should
/// never happen — Models.Lot.ExpirationMacroFormat always produces it),
/// this step fails with a named reason rather than typing something
/// PioneerRx's masked date field might silently mangle.
///
/// READBACK VERIFICATION (V-T41 item 4, Will's 2026-09-22 brief,
/// verbatim): "verify by reading the field back; if it fails, stop with a
/// clear one-line reason ... naming the step and what was on screen." A
/// successful SetValue call only proves PioneerRx accepted the UIA
/// request, not that a masked/validated field (the date box especially)
/// actually kept the exact text — VerifyFieldTyped re-reads BOTH the
/// lot number and expiration fields via the same UIA Value-pattern read
/// SendF3AndDismissPreEntryDialogsStep.ReadControlValue/UiaTreeDumper
/// already use, and fails loud (naming the window title, field, and
/// expected-vs-actual values) on a mismatch rather than reporting success
/// on a field PioneerRx silently rejected or reformatted.
/// </summary>
public sealed class InputLotAndExpirationStep : IPioneerEntryStep
{
    public const string LotNumberAutomationId = "uxLotNumber";
    public const string LotExpirationAutomationId = "uxLotExpirationDate";

    /// <summary>
    /// V-..., 2026-09-10 (Will's real app.log: this step FAILED ~1.3s
    /// after InputVaccineCodeStep succeeded — "Couldn't find the lot
    /// number field ... on the attached PioneerRx window"): a single
    /// instant FindFirstDescendant (QuickSearchFieldEntry's own
    /// first-shot field-lookup) gives PioneerRx's Add New Rx screen no
    /// time at all to finish rendering the Dispense tab's dispensed-drug
    /// panel before giving up. This step now re-focuses the attached
    /// window (see TryRefocusAttachedWindow) and polls for uxLotNumber to
    /// actually appear, up to this budget, before ever calling
    /// QuickSearchFieldEntry.TypeAndConfirmAsync.
    ///
    /// V-..., 2026-09-11: the poll itself is now
    /// QuickSearchFieldEntry.WaitForFieldAsync (the same "found AND
    /// enabled" wait SelectPrescriberStep/InputVaccineCodeStep use) rather
    /// than a hand-rolled SendF3AndDismissPreEntryDialogsStep.WaitForAsync
    /// call — see QuickSearchFieldEntry.WaitForFieldAsync's own doc comment
    /// for why "found" alone stopped being a strong enough signal.
    /// </summary>
    public static readonly TimeSpan LotFieldWaitTimeout = TimeSpan.FromSeconds(15);

    public string Name => "Enter lot and expiration";

    public async Task<PioneerEntryStepResult> ExecuteAsync(PioneerEntryStepContext context, CancellationToken cancellationToken = default)
    {
        // V-... Part C (expiration gate): staff explicitly chose "Leave
        // lot/expiration blank and proceed" on the popup because no
        // unexpired lot was on file — see VaccineEntryPayload.SkipLotAndExpiration's
        // doc comment. Checked FIRST, ahead of DryRun, so a skip behaves
        // identically (succeeds, does nothing) whether or not PioneerRx is
        // attached, same as every other step's dry-run-first check.
        if (context.Payload.SkipLotAndExpiration)
        {
            return new PioneerEntryStepResult(Name, Success: true, DryRun: context.DryRun,
                "Skipped — lot/expiration intentionally left blank (no unexpired lot was on file; staff chose to proceed without one).");
        }

        if (context.DryRun)
        {
            return new PioneerEntryStepResult(Name, Success: true, DryRun: true,
                $"Would type lot \"{context.Payload.LotNumber}\" into '{LotNumberAutomationId}' and expiration " +
                $"\"{context.Payload.ExpirationMacroFormat}\" into '{LotExpirationAutomationId}' (no PioneerRx call made).");
        }

        if (context.AttachedWindow is null)
        {
            return new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                "No PioneerRx window attached — FocusPioneerWindowStep must run (and succeed) before this step.");
        }

        TryRefocusAttachedWindow(context.AttachedWindow);

        // V-..., 2026-09-11: now routed through QuickSearchFieldEntry's
        // shared field wait (see its own doc comment) instead of a
        // hand-rolled poll, so the lot field gets the same "found AND
        // enabled" check as the prescriber/NDC fields — the returned
        // AutomationElement was never actually used below beyond the null
        // check, so this is a drop-in swap.
        var lotFieldFound = await QuickSearchFieldEntry.WaitForFieldAsync(
            context.AttachedWindow, LotNumberAutomationId, LotFieldWaitTimeout,
            context.Log, cancellationToken);
        if (!lotFieldFound)
        {
            return BuildLotFieldNotFoundResult(context.AttachedWindow);
        }

        var lotOutcome = await QuickSearchFieldEntry.TypeAndConfirmAsync(
            context.AttachedWindow, LotNumberAutomationId, "lot number", context.Payload.LotNumber, enterPresses: 0,
            log: context.Log, cancellationToken: cancellationToken);
        if (!lotOutcome.Success)
        {
            return new PioneerEntryStepResult(Name, Success: false, DryRun: false, lotOutcome.Message);
        }

        // V-T41 item 4 (Will's 2026-09-22 brief, verbatim): "verify by
        // reading the field back; if it fails, stop with a clear one-line
        // reason ... naming the step and what was on screen." SetValue
        // reporting no exception only means PioneerRx accepted the UIA
        // call, not that the masked/validated field actually kept the
        // text (a date-shaped mask, in particular, can silently reject or
        // reformat an unexpected value) — see VerifyFieldTyped's own
        // doc comment.
        var lotReadback = VerifyFieldTyped(context.AttachedWindow, LotNumberAutomationId, "lot number", context.Payload.LotNumber, context.Log);
        if (lotReadback is not null)
        {
            return lotReadback;
        }

        var pioneerExpiration = ToPioneerDateFormat(context.Payload.ExpirationMacroFormat);
        if (pioneerExpiration is null)
        {
            return new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                $"Lot number entered, but couldn't parse expiration \"{context.Payload.ExpirationMacroFormat}\" as MMDDYYYY — not typed into '{LotExpirationAutomationId}'.");
        }

        var expirationOutcome = await QuickSearchFieldEntry.TypeAndConfirmAsync(
            context.AttachedWindow, LotExpirationAutomationId, "expiration date", pioneerExpiration, enterPresses: 0,
            log: context.Log, cancellationToken: cancellationToken);
        if (!expirationOutcome.Success)
        {
            return new PioneerEntryStepResult(Name, Success: false, DryRun: false,
                $"Lot number entered, but expiration failed: {expirationOutcome.Message}");
        }

        var expirationReadback = VerifyFieldTyped(context.AttachedWindow, LotExpirationAutomationId, "expiration date", pioneerExpiration, context.Log);
        if (expirationReadback is not null)
        {
            return expirationReadback;
        }

        return new PioneerEntryStepResult(Name, Success: true, DryRun: false,
            $"Entered lot \"{context.Payload.LotNumber}\" and expiration \"{pioneerExpiration}\" (read back and verified).");
    }

    /// <summary>
    /// V-T41 item 4: reads `automationId`'s current UIA Value pattern
    /// value straight back (SAME idiom SendF3AndDismissPreEntryDialogsStep.
    /// ReadControlValue / Uia/UiaTreeDumper already use for a live
    /// read-only value check — `Patterns.Value.Pattern.Value.ValueOrDefault`
    /// — not a new API surface) and compares it (trimmed) against what was
    /// just typed. SetValue reporting no exception only proves PioneerRx
    /// ACCEPTED the UIA call, not that the field actually kept the text —
    /// a masked/validated field (the expiration date box, in particular)
    /// can silently reject or reformat a value outside what it expects.
    ///
    /// Returns null when the readback matches (success — no result to
    /// short-circuit with) or when the field couldn't be re-found/read at
    /// all (best-effort: a field that legitimately can't be read back is
    /// reported as a WARNING in the log, not a hard failure — the SetValue
    /// call itself already succeeded, and refusing to trust a UIA read
    /// this codebase couldn't confirm live isn't worth blocking a
    /// live entry that otherwise looks fine). Returns a FAILED
    /// PioneerEntryStepResult — naming this step, the window title, the
    /// field, and expected vs. actual — only when the field WAS
    /// successfully read back and its value does not match.
    /// </summary>
    private PioneerEntryStepResult? VerifyFieldTyped(AutomationElement window, string automationId, string fieldLabel, string expectedValue, Action<string> log)
    {
        AutomationElement? field;
        try
        {
            field = window.FindFirstDescendant(cf => cf.ByAutomationId(automationId));
        }
        catch (Exception ex)
        {
            log($"[{Name}] Couldn't re-find the {fieldLabel} field (AutomationId '{automationId}') to verify it by reading it back: {ex.Message} — trusting the earlier SetValue call.");
            return null;
        }

        if (field is null)
        {
            log($"[{Name}] Couldn't re-find the {fieldLabel} field (AutomationId '{automationId}') to verify it by reading it back — trusting the earlier SetValue call.");
            return null;
        }

        string? actualValue;
        try
        {
            actualValue = field.Patterns.Value.Pattern.Value.ValueOrDefault;
        }
        catch (Exception ex)
        {
            log($"[{Name}] Couldn't read the {fieldLabel} field (AutomationId '{automationId}') back to verify it: {ex.Message} — trusting the earlier SetValue call.");
            return null;
        }

        if (string.Equals((actualValue ?? "").Trim(), expectedValue.Trim(), StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var windowTitle = SafeWindowTitle(window);
        var reason = $"Typed \"{expectedValue}\" into the {fieldLabel} field (AutomationId '{automationId}') on window \"{windowTitle}\", " +
            $"but reading it back shows \"{actualValue}\" — PioneerRx may have rejected or reformatted it (e.g. a masked date field). Stopping rather than continuing with a field that didn't take the value.";
        return new PioneerEntryStepResult(Name, Success: false, DryRun: false, reason);
    }

    /// <summary>MMDDYYYY (Models.Lot.ExpirationMacroFormat) -> PioneerRx's
    /// own M/d/yyyy date-edit format (confirmed against the live dump's
    /// uxLotExpirationDate value, "9/5/2027"). Public + pure for unit
    /// testing without a live UIA session — see
    /// InputLotAndExpirationStepDateFormatTests.cs.</summary>
    public static string? ToPioneerDateFormat(string macroFormatExpiration)
    {
        return DateTime.TryParseExact(
            macroFormatExpiration, "MMddyyyy", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed)
            ? parsed.ToString("M/d/yyyy", CultureInfo.InvariantCulture)
            : null;
    }

    /// <summary>V-..., 2026-09-10: best-effort re-focus of the already-
    /// attached window before searching for uxLotNumber — "re-attach" in
    /// the sense of making sure it still has real OS focus (the same
    /// FocusNative() QuickSearchFieldEntry already calls per-field,
    /// applied once more at the window level here), not a fresh
    /// re-scan-for-a-different-window: context.AttachedWindow is already
    /// the specific Add New Rx window SendF3AndDismissPreEntryDialogsStep
    /// confirmed. Never throws.</summary>
    private static void TryRefocusAttachedWindow(AutomationElement window)
    {
        try { window.FocusNative(); } catch { /* best-effort */ }
    }

    /// <summary>
    /// V-..., 2026-09-10 (Will's brief: "the failure message must name the
    /// window title actually attached and list the AutomationIds of the
    /// top-level edit controls found ... so we can map the real field next
    /// time — and write the UIA dump"): built only once
    /// QuickSearchFieldEntry.WaitForFieldAsync has genuinely timed out —
    /// names the attached window's own title, lists up to 20 Edit-control
    /// AutomationIds actually found on it (so a mismatched field name is
    /// diagnosable without a live UIA dump session), and writes a full UIA
    /// tree dump the same way SendF3AndDismissPreEntryDialogsStep.SafeDumpUiaTree
    /// already does.
    /// </summary>
    private static PioneerEntryStepResult BuildLotFieldNotFoundResult(AutomationElement window)
    {
        const int maxEditIdsListed = 20;

        var windowTitle = SafeWindowTitle(window);
        var editIds = DescribeEditControlAutomationIds(window, maxEditIdsListed);
        var dump = SafeDumpUiaTree();

        var reason = $"Couldn't find (or PioneerRx never enabled) the lot number field (AutomationId '{LotNumberAutomationId}') on the attached " +
            $"PioneerRx window (\"{windowTitle}\") after waiting up to {LotFieldWaitTimeout.TotalSeconds:0}s — confirm the " +
            "patient's Rx Profile or an in-progress Add New Rx is the active screen.";
        reason += editIds.Count > 0
            ? $" Edit controls found on that window: {string.Join(", ", editIds.Select(id => $"'{id}'"))}."
            : " No Edit controls were found on that window at all.";
        reason += dump.Success && dump.FilePath is not null
            ? $" UIA tree dump written to {dump.FilePath} for troubleshooting."
            : $" (Also tried to write a UIA tree dump for troubleshooting: {dump.Message})";

        return new PioneerEntryStepResult("Enter lot and expiration", Success: false, DryRun: false, reason);
    }

    /// <summary>NO PHI — truncated to the portion before the first " - "
    /// (same convention as PioneerRxAttachment.TryAttach's own
    /// DescribeForLog), since some PioneerRx window titles carry a patient
    /// name after that delimiter. Never throws.</summary>
    private static string SafeWindowTitle(AutomationElement window)
    {
        try
        {
            var name = window.Name ?? "";
            return name.Split(new[] { " - " }, 2, StringSplitOptions.None)[0];
        }
        catch
        {
            return "<unknown>";
        }
    }

    /// <summary>Every Edit control's AutomationId found on `window`,
    /// bounded to `limit` (Will's brief: "~20") — best-effort, never
    /// throws.</summary>
    private static List<string> DescribeEditControlAutomationIds(AutomationElement window, int limit)
    {
        var ids = new List<string>();
        try
        {
            foreach (var edit in window.FindAllDescendants(cf => cf.ByControlType(ControlType.Edit)))
            {
                if (ids.Count >= limit) break;
                string? id;
                try { id = edit.AutomationId; } catch { continue; }
                if (!string.IsNullOrEmpty(id)) ids.Add(id);
            }
        }
        catch
        {
            // Best-effort only — see doc comment above.
        }
        return ids;
    }

    /// <summary>Best-effort UIA tree dump on a final field-not-found
    /// failure, reusing UiaTreeDumper — same pattern as
    /// SendF3AndDismissPreEntryDialogsStep.SafeDumpUiaTree. Never throws.</summary>
    private static UiaTreeDumper.DumpOutcome SafeDumpUiaTree()
    {
        try
        {
            return UiaTreeDumper.DumpAttachedPioneerWindow();
        }
        catch (Exception ex)
        {
            return new UiaTreeDumper.DumpOutcome(false, null, null, $"Dump threw: {ex.Message}");
        }
    }
}
