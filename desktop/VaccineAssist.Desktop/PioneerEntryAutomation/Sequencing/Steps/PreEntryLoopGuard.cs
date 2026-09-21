using System;
using System.Collections.Generic;
using VaccineAssist.Desktop.Uia;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// V-T41 ROUND 3 (Will's 2026-09-21 brief, point 2): "a given dialog kind
/// (e.g. Priority) handled more than 2 times in one run, or more than 3
/// Escapes total, -> stop with a clear error ... never an infinite/55-
/// second loop." Will's real log showed the "Priority" dialog handled 6
/// times (throttled log lines — see SendF3AndDismissPreEntryDialogsStep's
/// own class doc comment for the raw-attempt math) over ~26s, then a burst
/// of Escape keypresses against untitled windows over another ~5s, all
/// inside one single combined-loop run that never itself gave up: see
/// RunCombinedPreEntryLoopAsync's own doc comment — its ONLY give-up
/// signal is <c>maxEmptyTicks</c> CONSECUTIVE ticks where NOTHING was
/// dismissed, and every single one of those ticks WAS "dismissing"
/// something (the same recurring Priority dialog, or a fresh Escape
/// target), so <c>emptyTicks</c> reset to 0 every time and the loop's own
/// nominal ~15s budget (CombinedPreEntryLoopTimeout) was never actually
/// enforced. This class is the hard circuit breaker that closes that gap,
/// independent of whether round 3's classification fix (DialogClassifier's
/// new checks) also stops the specific windows seen in that log from ever
/// being Escaped again.
///
/// PURE — no UIA/Win32/threading dependency of its own; a single instance
/// is created per SendF3AndDismissPreEntryDialogsStep.ExecuteAsync call and
/// threaded through TryDismissNext, so counts never leak between runs.
/// </summary>
public sealed class PreEntryLoopGuard
{
    /// <summary>A given DialogKind handled more than this many times in one
    /// run trips the guard (i.e. the 3rd handling is the one that trips
    /// it).</summary>
    public const int MaxHandledPerDialogKind = 2;

    /// <summary>More than this many total Escape keypresses (across every
    /// window, known or unrecognized) sent in one run trips the guard (i.e.
    /// the 4th Escape is the one that trips it).</summary>
    public const int MaxTotalEscapes = 3;

    private readonly Dictionary<DialogKind, int> _handledCounts = new();
    private int _totalEscapes;

    public int TotalEscapes => _totalEscapes;

    public int HandledCount(DialogKind kind) => _handledCounts.TryGetValue(kind, out var count) ? count : 0;

    /// <summary>Call once each time `kind` is found and an attempt is made
    /// to resolve it (a Priority select/confirm attempt, or a known-title
    /// Escape). Returns true once `kind` has now been handled MORE THAN
    /// <see cref="MaxHandledPerDialogKind"/> times in this run.</summary>
    public bool RecordHandled(DialogKind kind)
    {
        _handledCounts.TryGetValue(kind, out var count);
        count++;
        _handledCounts[kind] = count;
        return count > MaxHandledPerDialogKind;
    }

    /// <summary>Call once each time an Escape keypress is actually sent to
    /// any pre-entry window (known-dialog Escape or a confirmed-blocking-
    /// modal unrecognized window — never for a Priority select/confirm,
    /// which doesn't Escape at all). Returns true once the total now
    /// exceeds <see cref="MaxTotalEscapes"/>.</summary>
    public bool RecordEscape()
    {
        _totalEscapes++;
        return _totalEscapes > MaxTotalEscapes;
    }
}

/// <summary>Thrown by SendF3AndDismissPreEntryDialogsStep's TryDismissNext
/// wrapper when PreEntryLoopGuard trips — caught in ExecuteAsync to build a
/// loud, explicit failure result (plus a NO-PHI window-inventory dump)
/// instead of letting the combined loop grind on for tens of seconds. See
/// PreEntryLoopGuard's own doc comment for why the combined loop's own
/// budget doesn't already catch this shape of stall.</summary>
public sealed class PreEntryLoopProtectionException : Exception
{
    public PreEntryLoopProtectionException(string message) : base(message)
    {
    }
}
