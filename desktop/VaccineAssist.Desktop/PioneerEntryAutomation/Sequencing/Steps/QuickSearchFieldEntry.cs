using System;
using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Input;
using FlaUI.Core.WindowsAPI;
using VaccineAssist.Desktop.Uia;

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

    /// <summary>V-T41 (Will, 2026-09-13 night): "still getting stuck on the
    /// pre-data entry popup windows" — once a quick-search field has been
    /// observed present-but-disabled for longer than this, WaitForFieldAsync
    /// logs a full PioneerWindowInventory.Describe() ONCE for that stall
    /// (not every tick) so app.log names whatever's actually blocking it
    /// (an unrecognized modal, or the screen still rendering) instead of
    /// just "present but disabled — waiting."</summary>
    private static readonly TimeSpan StallInventoryThreshold = TimeSpan.FromSeconds(2);

    /// <summary>V-T41: throttles the "Still waiting to enter the X" log
    /// line in TypeAndConfirmAsync's retry loop to roughly once per this
    /// interval (Will's brief, verbatim: "throttle the repeated 'Still
    /// waiting' line to every 5s") — replaces that call site's previous use
    /// of AutoWatchRetry.ShouldLogRetry (an ATTEMPT-count throttle that
    /// assumed a ~200ms poll interval, producing a line roughly every 1s —
    /// too chatty per this round's brief). See ShouldLogByElapsedInterval.</summary>
    private static readonly TimeSpan StillWaitingLogInterval = TimeSpan.FromSeconds(5);

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
        Stopwatch? disabledSince = null;
        var loggedStallInventory = false;

        AutomationElement? TryFind()
        {
            AutomationElement? candidate;
            try { candidate = window.FindFirstDescendant(cf => cf.ByAutomationId(automationId)); }
            catch { return null; }

            if (candidate is null)
            {
                // Not present at all (yet) -- distinct from "present but
                // disabled" below, so a field that briefly disappears
                // (e.g. a modal covering it) gets its own fresh stall
                // clock once it's found disabled again, rather than
                // inheriting an unrelated earlier stall's elapsed time.
                disabledSince = null;
                loggedStallInventory = false;
                return null;
            }

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

                // V-T41: log the window inventory ONCE per stall, only
                // once the field has actually been disabled for more than
                // StallInventoryThreshold — see that constant's doc
                // comment.
                disabledSince ??= Stopwatch.StartNew();
                if (!loggedStallInventory && disabledSince.Elapsed >= StallInventoryThreshold)
                {
                    loggedStallInventory = true;
                    log?.Invoke($"'{automationId}' still disabled after {disabledSince.Elapsed.TotalSeconds:0.0}s — " +
                        $"PioneerRx window inventory: {PioneerWindowInventory.Describe()}");
                }

                return null;
            }

            disabledSince = null;
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
            // V-T41 (Will, verbatim: "throttle the repeated 'Still waiting'
            // line to every 5s"): elapsed-time bucket throttle (see
            // ShouldLogByElapsedInterval), NOT the attempt-count-based
            // AutoWatchRetry.ShouldLogRetry this used before — that one
            // assumed a fixed ~200ms poll interval and fired roughly every
            // 1s, which is what generated the 40+-line "Still waiting"
            // spam in the night's app.log. `lastLoggedBucket` is local to
            // THIS field's retry run, so a later field's wait always logs
            // immediately on its own first attempt rather than inheriting
            // an earlier field's timing.
            var lastLoggedBucket = -1;
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
                    if (ShouldLogByElapsedInterval(elapsed, StillWaitingLogInterval, ref lastLoggedBucket))
                    {
                        log?.Invoke($"Still waiting to enter the {fieldLabel} (AutomationId '{automationId}') after " +
                            $"{elapsed.TotalSeconds:0.0}s — {ex.GetType().Name}: {ex.Message}. PioneerRx may be busy; retrying...");
                    }
                    await Task.Delay(PollInterval, cancellationToken);
                },
                cancellationToken: cancellationToken);
        }
        catch (Exception ex)
        {
            // V-T41: once the whole retry budget is exhausted (almost
            // always ElementNotEnabledException — the field exists but
            // PioneerRx hasn't enabled it, usually because some dialog
            // this repo doesn't recognize is still covering "Add New Rx"),
            // try ONE more thing before giving up outright — see
            // TryRefocusAndClickThenRetryOnce's own doc comment.
            if (AutoWatchErrorClassifier.IsRecoverable(ex))
            {
                var retried = TryRefocusAndClickThenRetryOnce(window, automationId, fieldLabel, value, enterPresses, log);
                if (retried is { } outcome) return outcome;
            }

            var inventory = PioneerWindowInventory.Describe();
            return new Outcome(false,
                $"Failed to enter the {fieldLabel} (AutomationId '{automationId}'): {DescribeException(ex)}. " +
                $"Last PioneerRx window inventory: {inventory}");
        }

        return new Outcome(true, $"Entered {fieldLabel} \"{value}\" and pressed ENTER {enterPresses} time(s).");
    }

    /// <summary>
    /// V-T41 (Will, verbatim): "If the field is still disabled after
    /// dialogs are clear, retry focusing the Add New Rx window (bring to
    /// front, click into the field area) before giving up." FocusNative
    /// alone (as used everywhere else on this path) gives OS keyboard
    /// focus to the WINDOW, not necessarily the specific control inside
    /// it — see this class's own doc comment on why FocusNative is used at
    /// all for these legacy WinForms controls. This adds one more
    /// concrete action beyond that: a real mouse click into the field's
    /// own on-screen bounds (FlaUI.Core.Input.Mouse.LeftClick), THEN the
    /// exact same SetValue/FocusNative/ENTER sequence, exactly once — no
    /// further retry loop of its own. Returns null (caller reports its own
    /// original failure, with a window inventory attached) if the field
    /// can't be re-found, still isn't enabled, or this attempt also
    /// throws. Never throws.
    /// </summary>
    private static Outcome? TryRefocusAndClickThenRetryOnce(
        AutomationElement window, string automationId, string fieldLabel, string value, int enterPresses, Action<string>? log)
    {
        try
        {
            log?.Invoke($"Retrying the {fieldLabel} field (AutomationId '{automationId}') once more after " +
                "re-focusing the Add New Rx window and clicking into the field...");

            window.FocusNative();

            var field = window.FindFirstDescendant(cf => cf.ByAutomationId(automationId));
            if (field is null) return null;

            try
            {
                var rect = field.BoundingRectangle;
                if (!rect.IsEmpty)
                {
                    Mouse.LeftClick(new Point(rect.X + rect.Width / 2, rect.Y + rect.Height / 2));
                }
            }
            catch
            {
                // Best-effort click -- still try SetValue below even if the click itself failed.
            }

            if (!field.Patterns.Value.IsSupported) return null;
            if (!field.Properties.IsEnabled.ValueOrDefault) return null;

            field.Patterns.Value.Pattern.SetValue(value);
            field.FocusNative();
            for (var i = 0; i < enterPresses; i++)
            {
                Keyboard.Type(VirtualKeyShort.RETURN);
            }

            return new Outcome(true, $"Entered {fieldLabel} \"{value}\" and pressed ENTER {enterPresses} time(s) (after a refocus-and-click retry).");
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// V-T41: pure "should I log this periodic status line" gate based on
    /// WALL-CLOCK elapsed time rather than an attempt counter — unlike
    /// AutoWatchRetry.ShouldLogRetry (which assumes a roughly-fixed poll
    /// interval between attempts), this fires on elapsed-time BUCKET
    /// boundaries, so the throttle interval means what it says regardless
    /// of how often the caller actually gets invoked. Fires on the very
    /// FIRST call (elapsed starts at/near zero, bucket 0 > the initial -1)
    /// and then again every time `elapsed` crosses into a further bucket.
    /// `lastLoggedBucket` is the caller's own persisted state across calls
    /// (start at -1) — mutated in place. Pure, no clock/UIA dependency of
    /// its own — directly unit-testable with plain TimeSpan values.
    /// </summary>
    public static bool ShouldLogByElapsedInterval(TimeSpan elapsed, TimeSpan interval, ref int lastLoggedBucket)
    {
        var bucket = (int)(elapsed.TotalMilliseconds / interval.TotalMilliseconds);
        if (bucket <= lastLoggedBucket) return false;
        lastLoggedBucket = bucket;
        return true;
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
