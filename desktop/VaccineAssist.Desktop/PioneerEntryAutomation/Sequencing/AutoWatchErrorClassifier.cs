using System;
using FlaUI.Core.Exceptions;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;

/// <summary>
/// V-T28 (Will, 2026-09-09): "Made it to the start of data entry into
/// Pioneer, then error: Unexpected error during auto-watch: Operation
/// timed out. (0x80131505)". 0x80131505 is COR_E_TIMEOUT — the .NET
/// runtime's own default HResult for <see cref="TimeoutException"/> — so a
/// raw UI Automation/FlaUI call (SetValue, FocusNative, FindFirstDescendant,
/// etc.) threw while PioneerRx's UI thread was busy/unresponsive for a
/// moment, and the single-shot try/catch around that call had no retry:
/// one transient stall failed the whole step (and, since
/// PioneerEntrySequenceRunner stops at the first failed step, the whole
/// entry) immediately, surfacing the runner's generic
/// "Unexpected error: ..." wording instead of a step-specific message.
///
/// This is the PURE classification half of the fix (unit-testable without
/// any live UIA session — see AutoWatchErrorClassifierTests.cs).
/// AutoWatchRetry is the other half: it retries an operation whose failure
/// classifies as recoverable here, up to an overall wall-clock budget,
/// before finally giving up.
///
/// Deliberately conservative: only exceptions that look like a TRANSIENT
/// "the other side didn't respond in time" condition are recoverable.
/// Anything else (a field genuinely not found, an unsupported UIA pattern,
/// a real argument/parse error) keeps failing immediately, unchanged from
/// today — retrying THOSE would just burn the whole budget on a failure
/// that was never going to un-happen.
/// </summary>
public static class AutoWatchErrorClassifier
{
    /// <summary>COR_E_TIMEOUT — System.TimeoutException's own default
    /// HResult (corerror.h). The EXACT code from Will's V-T28 report.</summary>
    private const int CorETimeout = unchecked((int)0x80131505);

    /// <summary>RPC_E_TIMEOUT — a COM cross-apartment/cross-process call
    /// (which is what every UIA client call to PioneerRx's provider is)
    /// didn't get a response in time. Standard, long-documented Windows COM
    /// error code (winerror.h).</summary>
    private const int RpcETimeout = unchecked((int)0x8001010F);

    /// <summary>RPC_E_SERVERCALL_RETRYLATER — the target app's message pump
    /// is busy processing something else right now but may accept the call
    /// shortly; same "come back later" shape as a timeout, seen from COM
    /// calls into a target app that's mid-redraw or showing a native modal.
    /// Standard Windows COM error code (winerror.h).</summary>
    private const int RpcEServerCallRetryLater = unchecked((int)0x8001010A);

    /// <summary>
    /// True if <paramref name="ex"/> (or any exception in its
    /// InnerException chain) represents a transient "the other side didn't
    /// respond in time" condition worth retrying, rather than a genuine
    /// failure worth surfacing immediately.
    /// </summary>
    public static bool IsRecoverable(Exception? ex)
    {
        for (var current = ex; current is not null; current = current.InnerException)
        {
            if (current is TimeoutException) return true;

            // V-..., 2026-09-11 (owner's log, 17:15, build 7ab6500): the
            // prescriber field existed 416ms after F3 but threw this on
            // FocusNative/SetValue — PioneerRx hadn't finished enabling it
            // yet. QuickSearchFieldEntry.WaitForFieldAsync now waits for
            // Properties.IsEnabled before treating a field as found, but the
            // field can still flip disabled again in the gap between that
            // wait and TypeAndConfirmAsync's actual SetValue — treating this
            // as recoverable lets the existing AutoWatchRetry loop keep
            // retrying within its budget instead of failing loud on a
            // one-tick race.
            if (current is ElementNotEnabledException) return true;

            if (IsTimeoutHResult(current.HResult)) return true;

            // Belt-and-suspenders: some COM interop paths surface a plain
            // Exception (not TimeoutException/COMException) whose Message
            // still reads exactly like Will's report ("Operation timed
            // out."/"...timed out..."). Matching on that text too means a
            // wrapper type we didn't anticipate still gets treated as
            // recoverable rather than falling through to "Unexpected
            // error" again.
            if (!string.IsNullOrEmpty(current.Message) &&
                current.Message.Contains("timed out", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsTimeoutHResult(int hResult) =>
        hResult == CorETimeout || hResult == RpcETimeout || hResult == RpcEServerCallRetryLater;
}
