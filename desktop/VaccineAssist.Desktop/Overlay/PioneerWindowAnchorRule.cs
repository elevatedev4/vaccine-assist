using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;

namespace VaccineAssist.Desktop.Overlay;

/// <summary>
/// Pure decision behind which of PioneerRx's own top-level windows the
/// overlay icon anchors to (Will, 2026-09-25 verbatim: "The icon for
/// Pioneer overlay needs to follow the user to the active pioneer window
/// (focused window), like RxOverlay does. We always have two pioneers
/// open.") — no WPF/Win32 dependency, so it's unit-testable directly
/// (see VaccineAssist.Desktop.Tests\PioneerWindowAnchorRuleTests.cs),
/// mirroring rx-verify's own Integrated/MainWindowAnchorRule.cs — that
/// class's "ROUND 8" fix was the identical complaint against its
/// integrated verify-box overlay ("We always have 2 pioneer instances
/// open. If I change my focus to another pioneer window, I need the app
/// overlay to integrate on that window").
///
/// PioneerMainWindowLocator (the impure half — EnumWindows/
/// GetForegroundWindow/GetWindowRect) builds the candidate list and the
/// current foreground handle every ~250ms tick and hands them to <see
/// cref="Resolve"/>, which:
///   1. Prefers the CURRENT foreground handle when it's one of Pioneer's
///      own top-level windows (i.e. it's in <paramref name="candidates"/>)
///      and eligible — this is what makes the icon follow the user
///      between two open PioneerRx windows on Alt+Tab/click. Unlike
///      rx-verify's own rule, there's no "must be maximized" requirement
///      here: this icon isn't drawing anything that would misbehave
///      anchored to a smaller/restored Pioneer window, so any eligible
///      foreground Pioneer window wins outright (see
///      PioneerMainWindowLocator's own doc comment for why it can afford
///      to be simpler here).
///   2. Otherwise stays on the previously-cached handle (the LAST
///      Pioneer window the user was in) as long as it's still eligible —
///      this is what keeps the icon in place when focus moves to some
///      OTHER, non-Pioneer window (e.g. vaccine-assist's own window): it
///      does NOT jump to whichever Pioneer window happens to be largest,
///      it just stays put. A minimized cached window is still found here
///      (Eligible only requires IsVisible + a sane rect — Win32 keeps
///      IsWindowVisible true for a minimized window; only IsIconic
///      distinguishes it), so the icon keeps tracking it; it's
///      PioneerOverlayController.Tick() that actually hides the icon once
///      Anchor.IsMinimized comes back true, not this rule.
///   3. Falls back to a fresh <see cref="Choose"/> (largest eligible
///      candidate) only when NEITHER the foreground nor the cached
///      handle resolves to anything still open — e.g. the very first
///      tick, or after the previously-anchored window was closed
///      entirely.
/// </summary>
public static class PioneerWindowAnchorRule
{
    /// <summary>Plain Win32 snapshot of one of PioneerRx's own top-level windows.</summary>
    public readonly record struct Candidate(IntPtr Handle, bool IsVisible, bool IsMinimized, Rectangle Bounds);

    /// <summary>Which HWND/rect/minimized-state to anchor the overlay icon to.</summary>
    public readonly record struct Anchor(IntPtr Handle, Rectangle Bounds, bool IsMinimized);

    /// <summary>
    /// STICKY-WITH-FOCUS-FOLLOW entry point — call this every tick.
    /// <paramref name="cachedHandle"/> is whatever <see cref="Anchor.Handle"/>
    /// the PREVIOUS call returned (IntPtr.Zero if there wasn't one yet,
    /// e.g. the very first tick or after a run where nothing was found).
    ///
    /// FOCUS-FOLLOW: if <paramref name="foregroundHandle"/> is a
    /// DIFFERENT, eligible candidate than <paramref name="cachedHandle"/>,
    /// it wins immediately — the user just switched to Pioneer's other
    /// window. Pass IntPtr.Zero (the default) to skip this check
    /// entirely and get plain stickiness.
    /// </summary>
    public static Anchor? Resolve(IntPtr cachedHandle, IReadOnlyList<Candidate> candidates, IntPtr foregroundHandle = default)
    {
        if (foregroundHandle != IntPtr.Zero && foregroundHandle != cachedHandle)
        {
            foreach (var candidate in candidates)
            {
                if (candidate.Handle == foregroundHandle && IsEligible(candidate))
                {
                    return new Anchor(candidate.Handle, candidate.Bounds, candidate.IsMinimized);
                }
            }
        }

        if (cachedHandle != IntPtr.Zero)
        {
            foreach (var candidate in candidates)
            {
                if (candidate.Handle == cachedHandle && IsEligible(candidate))
                {
                    return new Anchor(candidate.Handle, candidate.Bounds, candidate.IsMinimized);
                }
            }
        }

        return Choose(candidates);
    }

    /// <summary>
    /// Fresh selection with no memory of any previous pick: the largest
    /// (by rect area) eligible candidate. Null when there are none (e.g.
    /// PioneerRx has no window open at all, or every one is
    /// invisible/degenerate).
    /// </summary>
    public static Anchor? Choose(IReadOnlyList<Candidate> candidates)
    {
        var eligible = candidates.Where(IsEligible).ToList();
        if (eligible.Count == 0) return null;

        var best = eligible.OrderByDescending(c => Area(c.Bounds)).First();
        return new Anchor(best.Handle, best.Bounds, best.IsMinimized);
    }

    private static bool IsEligible(Candidate candidate) => candidate.IsVisible && IsSaneWindowRect(candidate.Bounds);

    /// <summary>Never anchor to a zero/negative-size rect.</summary>
    public static bool IsSaneWindowRect(Rectangle rect) => rect.Width > 0 && rect.Height > 0;

    private static long Area(Rectangle rect) => (long)rect.Width * rect.Height;
}
