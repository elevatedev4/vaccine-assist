using System;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Input;
using FlaUI.Core.WindowsAPI;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// Shared "type a value into a PioneerRx quick-search Edit field, then
/// press ENTER N times" mechanism used by SelectPrescriberStep (physician
/// alternate ID, ENTER twice) and InputVaccineCodeStep (drug NDC, ENTER
/// twice) — both fields are the same shape in the live UIA dumps
/// (Edit control, Value pattern only, no separate popup/dialog appears
/// when the search resolves — confirmed against the "Add New Rx"
/// progressive-state dumps, 2026-09-05: uxPrescriberQuickSearch and
/// uxPrescribedItemQuickSearch both went from blank to a resolved
/// value with no new top-level window appearing in between).
///
/// SetValue (UIA ValuePattern) sets the text directly — it does NOT, by
/// itself, give the control real OS keyboard focus, so the ENTER
/// keystrokes below (real synthetic input, FlaUI.Core.Input.Keyboard —
/// there is no UIA "InvokeSearch" pattern PioneerRx exposes for this) would
/// land wherever focus already was without an explicit focus call first.
/// FocusNative() (not the plain UIA Focus()) is used deliberately: FlaUI's
/// own guidance is that legacy UI stacks — every control in these dumps is
/// a WindowsForms10.* class — don't reliably respond to the UIA-level
/// SetFocus() request FlaUI.Focus() sends, and PioneerRx's editable
/// quick-search fields are exactly that kind of control.
/// </summary>
/// <remarks>Public rather than internal since this repo has no
/// InternalsVisibleTo wired up (same reasoning as
/// Uia/UiaTreeDumper.TruncateValue's own doc comment) — WaitForFieldCoreAsync
/// below needs to be reachable from VaccineAssist.Desktop.Tests.</remarks>
public static class QuickSearchFieldEntry
{
    /// <summary>Poll interval between retries of a recoverable (timed-out)
    /// SetValue/FocusNative/ENTER attempt — see V-T28's AutoWatchRetry.
    /// Same 200ms shape as SendF3AndDismissPreEntryDialogsStep.PollInterval;
    /// not shared with it (this class has no other relationship to that
    /// step beyond both living on the entry-sequence path).</summary>
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(200);

    /// <summary>
    /// V-..., 2026-09-11 (owner's log, 15:43, build ef5058f): "Select
    /// prescriber" FAILED the same way "Enter lot and expiration" did on
    /// 2026-09-10 before InputLotAndExpirationStep was hardened — a single
    /// instant FindFirstDescendant gives PioneerRx's Add New Rx screen no
    /// time to finish rendering before giving up (see
    /// SendF3AndDismissPreEntryDialogsStep.IsAddNewRxReady's own doc
    /// comment: it fires the instant the next field is FIRST detectable,
    /// not once the form has actually settled). The prescriber field never
    /// got that fix; the very next field (drug/NDC,
    /// uxPrescribedItemQuickSearch) is the identical one-shot shape, so it
    /// gets the same wait pre-emptively rather than waiting for its own
    /// failure log first. 15s default (WaitForFieldAsync below is called
    /// with this), same budget as InputLotAndExpirationStep.LotFieldWaitTimeout
    /// — kept as a SEPARATE constant here rather than referencing that
    /// step's, so this class (already shared by all three field-typing
    /// steps) doesn't take a dependency on one specific step's public
    /// surface.
    /// </summary>
    public static readonly TimeSpan DefaultFieldWaitTimeout = TimeSpan.FromSeconds(15);

    private static readonly TimeSpan FieldWaitPollInterval = TimeSpan.FromMilliseconds(250);

    public readonly record struct Outcome(bool Success, string Message);

    /// <summary>
    /// Re-focuses `window` (best-effort, never throws — same pattern as
    /// InputLotAndExpirationStep.TryRefocusAttachedWindow) and then polls
    /// for `automationId` to actually appear on it, up to `timeout` — the
    /// live (FlaUI/UIA-dependent, not independently unit-testable — same
    /// posture as every other live UIA branch in this sequence) wrapper
    /// around the pure WaitForFieldCoreAsync below. Also used directly by
    /// InputLotAndExpirationStep for its uxLotNumber wait (V-...,
    /// 2026-09-11 — previously its own hand-rolled poll).
    ///
    /// Deliberately does NOT itself build a "field not found" failure
    /// message: the caller's very next call to TypeAndConfirmAsync already
    /// does its own FindFirstDescendant and produces that message
    /// (unchanged wording) if the field still isn't there once this wait
    /// gives up — so on timeout this method just returns false without
    /// logging. On success it reports the wait via `log` (never on
    /// timeout) so the step log shows how long PioneerRx actually took to
    /// render the field.
    ///
    /// V-..., 2026-09-11 (owner's log, 17:15, build 7ab6500 which added
    /// this very method): "waited 416ms for 'uxPrescriberQuickSearch' to
    /// appear" immediately followed by "FAILED ... ElementNotEnabledException"
    /// — the field EXISTS well before PioneerRx has finished initializing
    /// the Add New Rx form, so FindFirstDescendant alone isn't a strong
    /// enough "ready" signal. TryFind below now also requires
    /// Properties.IsEnabled.ValueOrDefault before treating the field as
    /// found, logging once (not per-tick) when it sees the field present
    /// but still disabled so the next log line shows how long PioneerRx
    /// actually takes to enable it.
    /// </summary>
    public static Task<bool> WaitForFieldAsync(
        AutomationElement window, string automationId, TimeSpan timeout,
        Action<string>? log = null, CancellationToken cancellationToken = default)
    {
        try { window.FocusNative(); } catch { /* best-effort, same as InputLotAndExpirationStep.TryRefocusAttachedWindow */ }

        var loggedDisabled = false;

        AutomationElement? TryFind()
        {
            AutomationElement? candidate;
            try { candidate = window.FindFirstDescendant(cf => cf.ByAutomationId(automationId)); }
            catch { return null; }

            if (candidate is null) return null;

            bool isEnabled;
            try { isEnabled = candidate.Properties.IsEnabled.ValueOrDefault; }
            catch { return null; } // best-effort — same "any exception = not ready yet" posture as the FindFirstDescendant catch above

            if (!isEnabled)
            {
                if (!loggedDisabled)
                {
                    loggedDisabled = true;
                    log?.Invoke($"'{automationId}' present but disabled — waiting");
                }
                return null;
            }

            return candidate;
        }

        var maxEmptyTicks = (int)Math.Ceiling(timeout.TotalMilliseconds / FieldWaitPollInterval.TotalMilliseconds);
        return WaitForFieldCoreAsync(
            TryFind, automationId, maxEmptyTicks,
            () => Task.Delay(FieldWaitPollInterval, cancellationToken),
            log, cancellationToken);
    }

    /// <summary>
    /// PURE core of WaitForFieldAsync — reuses
    /// SendF3AndDismissPreEntryDialogsStep.WaitForAsync's single-signal
    /// overload (the shared polling primitive, not a new hand-rolled loop)
    /// and adds the "log how long it took, only on success" behavior on
    /// top. Generic (not AutomationElement-specific) so it's directly
    /// unit-testable with a fake finder delegate — see
    /// QuickSearchFieldEntryWaitTests.cs — same "pure logic split out for
    /// testability" pattern as WaitForAsync itself.
    /// </summary>
    public static async Task<bool> WaitForFieldCoreAsync<T>(
        Func<T?> tryFind, string automationId, int maxEmptyTicks, Func<Task> waitTick,
        Action<string>? log, CancellationToken cancellationToken = default)
        where T : class
    {
        var stopwatch = Stopwatch.StartNew();
        var found = await SendF3AndDismissPreEntryDialogsStep.WaitForAsync(tryFind, maxEmptyTicks, waitTick, cancellationToken);

        if (found is null)
        {
            return false;
        }

        log?.Invoke($"waited {stopwatch.ElapsedMilliseconds}ms for '{automationId}' to appear.");
        return true;
    }

    /// <summary>
    /// V-T28 (Will, 2026-09-09): "Made it to the start of data entry into
    /// Pioneer, then error: Unexpected error during auto-watch: Operation
    /// timed out. (0x80131505)" — this is the single shared method every
    /// live field-typing step (SelectPrescriberStep, InputVaccineCodeStep,
    /// InputLotAndExpirationStep x2, InputQuantityStep, InputDirectionsStep)
    /// calls, and previously made exactly ONE attempt at
    /// SetValue/FocusNative/ENTER with no retry — a single transient
    /// "PioneerRx didn't respond to this one UIA call in time" failed
    /// whichever step was typing at that moment (and, since
    /// PioneerEntrySequenceRunner stops at the first failed step, the whole
    /// entry) immediately. Now retries a recoverable failure (see
    /// AutoWatchErrorClassifier) for up to AutoWatchRetry.DefaultOverallBudget
    /// (60s default) before giving up — `log`, when given, is called once
    /// per retry (never on the final give-up) so the step log/AppFileLog
    /// shows "still waiting" progress instead of the popup just sitting
    /// there with no explanation for up to a minute.
    ///
    /// Renamed from the old synchronous TypeAndConfirm (Async suffix,
    /// matching every other awaited method on this path) — the "field not
    /// found" / "Value pattern not supported" checks stay single-shot
    /// (those are never transient — retrying "this control simply isn't a
    /// text field" for 60s would just burn the whole budget on a failure
    /// that was never going to un-happen), only the actual
    /// SetValue/FocusNative/ENTER attempt is retried.
    /// </summary>
    public static async Task<Outcome> TypeAndConfirmAsync(
        AutomationElement window, string automationId, string fieldLabel, string value, int enterPresses,
        Action<string>? log = null, CancellationToken cancellationToken = default)
    {
        AutomationElement? field;
        try
        {
            field = window.FindFirstDescendant(cf => cf.ByAutomationId(automationId));
        }
        catch (Exception ex)
        {
            return new Outcome(false, $"Couldn't search for the {fieldLabel} field (AutomationId '{automationId}'): {ex.Message}");
        }

        if (field is null)
        {
            return new Outcome(false,
                $"Couldn't find the {fieldLabel} field (AutomationId '{automationId}') on the attached PioneerRx window — " +
                "confirm the patient's Rx Profile or an in-progress Add New Rx is the active screen.");
        }

        try
        {
            if (!field.Patterns.Value.IsSupported)
            {
                return new Outcome(false, $"The {fieldLabel} field (AutomationId '{automationId}') doesn't support the UIA Value pattern — can't type into it.");
            }
        }
        catch (Exception ex)
        {
            return new Outcome(false, $"Couldn't check the {fieldLabel} field's Value pattern support (AutomationId '{automationId}'): {ex.Message}");
        }

        try
        {
            await AutoWatchRetry.RunAsync(
                attempt: () =>
                {
                    field.Patterns.Value.Pattern.SetValue(value);
                    field.FocusNative();
                    for (var i = 0; i < enterPresses; i++)
                    {
                        Keyboard.Type(VirtualKeyShort.RETURN);
                    }
                    return true;
                },
                overallBudget: AutoWatchRetry.DefaultOverallBudget,
                now: () => DateTime.UtcNow,
                onRecoverableWait: async (ex, elapsed) =>
                {
                    log?.Invoke($"Still waiting to enter the {fieldLabel} (AutomationId '{automationId}') after " +
                        $"{elapsed.TotalSeconds:0.0}s — {ex.GetType().Name}: {ex.Message}. PioneerRx may be busy; retrying...");
                    await Task.Delay(PollInterval, cancellationToken);
                },
                cancellationToken: cancellationToken);
        }
        catch (Exception ex)
        {
            return new Outcome(false, $"Failed to enter the {fieldLabel} (AutomationId '{automationId}'): {DescribeException(ex)}");
        }

        return new Outcome(true, $"Entered {fieldLabel} \"{value}\" and pressed ENTER {enterPresses} time(s).");
    }

    /// <summary>
    /// V-..., 2026-09-11 (owner's log, 15:43): the "Select prescriber"
    /// failure line ended right after the colon — "FAILED — Failed to
    /// enter the prescriber (AutomationId 'uxPrescriberQuickSearch'):" with
    /// nothing after it, meaning ex.Message came back empty (or the first
    /// line of a multi-line message was blank). Builds
    /// "{ExceptionTypeName}: {first non-blank line of Message}" instead of
    /// interpolating ex.Message directly, so the next failure always has
    /// SOMETHING to go on even when Message itself is empty — and appends
    /// the HResult in hex for a COMException specifically, since FlaUI/UIA
    /// failures are frequently COMExceptions whose HResult is the only
    /// useful signal when Message is blank. Never throws. Public (not
    /// private) — same "no InternalsVisibleTo, so testable pure logic goes
    /// public" reasoning as this class's own accessibility and
    /// WaitForFieldCoreAsync above — so it's directly unit-testable with
    /// plain Exception instances (no FlaUI/UIA dependency at all); see
    /// QuickSearchFieldEntryWaitTests.cs.
    /// </summary>
    public static string DescribeException(Exception ex)
    {
        var typeName = ex.GetType().Name;
        var firstLine = (ex.Message ?? string.Empty)
            .Split('\n')
            .Select(line => line.TrimEnd('\r').Trim())
            .FirstOrDefault(line => line.Length > 0);
        var text = firstLine ?? "<empty message>";
        var hresultSuffix = ex is COMException
            ? $" (HResult 0x{ex.HResult:X8})"
            : string.Empty;
        return $"{typeName}: {text}{hresultSuffix}";
    }
}
