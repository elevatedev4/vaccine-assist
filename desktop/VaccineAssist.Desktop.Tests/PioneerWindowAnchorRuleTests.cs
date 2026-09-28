using System.Drawing;
using VaccineAssist.Desktop.Overlay;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Unit tests for PioneerWindowAnchorRule (Overlay/PioneerWindowAnchorRule.cs)
/// — the pure decision behind Will's 2026-09-25 fix ("The icon for
/// Pioneer overlay needs to follow the user to the active pioneer window
/// (focused window), like RxOverlay does. We always have two pioneers
/// open.") and his 2026-09-28 follow-up ("Make the blue icon stay pinned
/// to the top right of the screen just like the RxVerify overlay is. Use
/// the same logic. That way it doesn't pop on every little mini screen
/// pioneer might pop up."). Modeled directly on rx-verify's own
/// MainWindowAnchorRuleTests.cs (its "ROUND 8" focus-follow tests plus the
/// maximized-only requirement), now including the maximized-only cases
/// that were previously dropped as not applying here.
///
/// Unless a test is specifically exercising maximized-vs-not behavior,
/// candidates below are built with IsMaximized: true so the pre-existing
/// (pre-2026-09-28) assertions keep testing exactly what they always did:
/// with every eligible candidate maximized, the "prefer maximized" pool
/// in Choose degenerates to the plain eligible set.
/// </summary>
public class PioneerWindowAnchorRuleTests
{
    private static readonly IntPtr HandleA = new(1);
    private static readonly IntPtr HandleB = new(2);
    private static readonly IntPtr HandleC = new(3);

    // ------------------------------------------------------------------
    // Choose (fresh selection, no memory of a previous pick)
    // ------------------------------------------------------------------

    [Fact]
    public void LargestEligibleCandidateWins()
    {
        var smaller = new PioneerWindowAnchorRule.Candidate(Handle: HandleA, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(100, 100, 400, 300));
        var bigger = new PioneerWindowAnchorRule.Candidate(Handle: HandleB, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(0, 0, 1920, 1040));

        var anchor = PioneerWindowAnchorRule.Choose(new[] { smaller, bigger });

        Assert.Equal(HandleB, anchor!.Value.Handle);
        Assert.Equal(bigger.Bounds, anchor.Value.Bounds);
    }

    [Fact]
    public void SkipsInvisibleCandidates()
    {
        var invisible = new PioneerWindowAnchorRule.Candidate(Handle: HandleA, IsVisible: false, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(0, 0, 1920, 1040));
        var visible = new PioneerWindowAnchorRule.Candidate(Handle: HandleB, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(0, 0, 800, 600));

        var anchor = PioneerWindowAnchorRule.Choose(new[] { invisible, visible });

        Assert.Equal(HandleB, anchor!.Value.Handle);
    }

    [Fact]
    public void SkipsCandidatesWithADegenerateRectEvenIfVisible()
    {
        var degenerate = new PioneerWindowAnchorRule.Candidate(Handle: HandleA, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(0, 0, 0, 0));
        var normal = new PioneerWindowAnchorRule.Candidate(Handle: HandleB, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(0, 0, 800, 600));

        var anchor = PioneerWindowAnchorRule.Choose(new[] { degenerate, normal });

        Assert.Equal(HandleB, anchor!.Value.Handle);
    }

    [Fact]
    public void MinimizedCandidatesAreStillEligibleForAFreshChoose()
    {
        // Minimized is not the same as invisible/hidden in Win32 — a
        // minimized window still keeps IsWindowVisible true (see the
        // rule's own doc comment). A fresh pick with nothing else open
        // should still be able to land on it; PioneerOverlayController
        // is what actually hides the icon based on Anchor.IsMinimized.
        var onlyMinimized = new PioneerWindowAnchorRule.Candidate(Handle: HandleA, IsVisible: true, IsMinimized: true, IsMaximized: true, Bounds: new Rectangle(0, 0, 1920, 1040));

        var anchor = PioneerWindowAnchorRule.Choose(new[] { onlyMinimized });

        Assert.Equal(HandleA, anchor!.Value.Handle);
        Assert.True(anchor.Value.IsMinimized);
    }

    [Fact]
    public void EmptyCandidatesProducesNoAnchor()
    {
        var anchor = PioneerWindowAnchorRule.Choose(Array.Empty<PioneerWindowAnchorRule.Candidate>());

        Assert.Null(anchor);
    }

    [Fact]
    public void ChooseFallsBackToTheLargestEligibleCandidateWhenNoneIsMaximized()
    {
        // Neither open Pioneer window is maximized (e.g. both restored
        // mid-drag) — Choose must not come back empty, it should still
        // pick the largest eligible candidate overall.
        var smallerRestored = new PioneerWindowAnchorRule.Candidate(Handle: HandleA, IsVisible: true, IsMinimized: false, IsMaximized: false, Bounds: new Rectangle(100, 100, 400, 300));
        var biggerRestored = new PioneerWindowAnchorRule.Candidate(Handle: HandleB, IsVisible: true, IsMinimized: false, IsMaximized: false, Bounds: new Rectangle(0, 0, 1200, 900));

        var anchor = PioneerWindowAnchorRule.Choose(new[] { smallerRestored, biggerRestored });

        Assert.Equal(HandleB, anchor!.Value.Handle);
        Assert.Equal(biggerRestored.Bounds, anchor.Value.Bounds);
    }

    // ------------------------------------------------------------------
    // Resolve (sticky entry point, no foreground supplied)
    // ------------------------------------------------------------------

    [Fact]
    public void ResolveWithNoCachedHandleFallsThroughToChoose()
    {
        var candidate = new PioneerWindowAnchorRule.Candidate(Handle: HandleA, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(0, 0, 1920, 1040));

        var anchor = PioneerWindowAnchorRule.Resolve(IntPtr.Zero, new[] { candidate });

        Assert.Equal(HandleA, anchor!.Value.Handle);
    }

    [Fact]
    public void ResolveTracksTheCachedWindowsRectWhenItMovesOrResizes()
    {
        var moved = new PioneerWindowAnchorRule.Candidate(Handle: HandleA, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(10, 20, 1900, 1000));

        var anchor = PioneerWindowAnchorRule.Resolve(HandleA, new[] { moved });

        Assert.Equal(moved.Bounds, anchor!.Value.Bounds);
    }

    [Fact]
    public void ResolveReEvaluatesWhenTheCachedHandleIsNoLongerAmongTheCandidates()
    {
        // The previously-anchored window closed entirely.
        var newWindow = new PioneerWindowAnchorRule.Candidate(Handle: HandleB, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(0, 0, 1920, 1040));

        var anchor = PioneerWindowAnchorRule.Resolve(HandleA, new[] { newWindow });

        Assert.Equal(HandleB, anchor!.Value.Handle);
    }

    [Fact]
    public void ResolveKeepsReturningTheCachedHandleEvenOnceItIsMinimized()
    {
        // Requirement 1 (Will's brief): a non-Pioneer window took focus,
        // and the last Pioneer window the user was in has since been
        // minimized — Resolve must still report it as the anchor (with
        // IsMinimized true) rather than silently switching to some other
        // open Pioneer window; PioneerOverlayController is what hides
        // the icon for a minimized anchor, not this rule.
        var nowMinimized = new PioneerWindowAnchorRule.Candidate(Handle: HandleA, IsVisible: true, IsMinimized: true, IsMaximized: false, Bounds: new Rectangle(0, 0, 1920, 1040));
        var otherOpenPioneerWindow = new PioneerWindowAnchorRule.Candidate(Handle: HandleB, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(0, 0, 800, 600));

        var anchor = PioneerWindowAnchorRule.Resolve(HandleA, new[] { nowMinimized, otherOpenPioneerWindow });

        Assert.Equal(HandleA, anchor!.Value.Handle);
        Assert.True(anchor.Value.IsMinimized);
    }

    [Fact]
    public void ResolveReEvaluatesWhenTheCachedHandleHasBecomeInvisible()
    {
        var nowInvisible = new PioneerWindowAnchorRule.Candidate(Handle: HandleA, IsVisible: false, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(0, 0, 1920, 1040));
        var fallback = new PioneerWindowAnchorRule.Candidate(Handle: HandleC, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(0, 0, 800, 600));

        var anchor = PioneerWindowAnchorRule.Resolve(HandleA, new[] { nowInvisible, fallback });

        Assert.Equal(HandleC, anchor!.Value.Handle);
    }

    [Fact]
    public void ResolveReturnsNullWhenNothingIsEligibleEvenWithAStaleCachedHandle()
    {
        var anchor = PioneerWindowAnchorRule.Resolve(HandleA, Array.Empty<PioneerWindowAnchorRule.Candidate>());

        Assert.Null(anchor);
    }

    // ------------------------------------------------------------------
    // Resolve — focus-follow (multi-instance PioneerRx)
    // ------------------------------------------------------------------

    [Fact]
    public void ResolveReAnchorsToTheOtherPioneerWindowThatTookForeground()
    {
        // Two maximized PioneerRx instances open. The overlay is anchored
        // to A; the user alt-tabs/clicks to B. Resolve must switch to B
        // immediately, without waiting for A to become ineligible — this
        // is Will's exact complaint (and must keep working after the
        // 2026-09-28 maximized-only change, since he still runs two
        // maximized Pioneers side by side).
        var currentAnchor = new PioneerWindowAnchorRule.Candidate(Handle: HandleA, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(0, 0, 1920, 1040));
        var newlyForegrounded = new PioneerWindowAnchorRule.Candidate(Handle: HandleB, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(1920, 0, 1920, 1040));

        var anchor = PioneerWindowAnchorRule.Resolve(HandleA, new[] { currentAnchor, newlyForegrounded }, foregroundHandle: HandleB);

        Assert.Equal(HandleB, anchor!.Value.Handle);
        Assert.Equal(newlyForegrounded.Bounds, anchor.Value.Bounds);
    }

    [Fact]
    public void ResolveDoesNotStealTheAnchorForANonMaximizedForegroundPioneerDialog()
    {
        // 2026-09-28 (Will verbatim: "Make the blue icon stay pinned to
        // the top right of the screen just like the RxVerify overlay is.
        // Use the same logic. That way it doesn't pop on every little
        // mini screen pioneer might pop up."): a small Pioneer dialog
        // (never maximized) takes foreground over the maximized main
        // window — the icon must stay put on the maximized window, not
        // jump to the dialog.
        var maximizedMainWindow = new PioneerWindowAnchorRule.Candidate(Handle: HandleA, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(0, 0, 1920, 1040));
        var miniDialog = new PioneerWindowAnchorRule.Candidate(Handle: HandleB, IsVisible: true, IsMinimized: false, IsMaximized: false, Bounds: new Rectangle(600, 400, 400, 250));

        var anchor = PioneerWindowAnchorRule.Resolve(HandleA, new[] { maximizedMainWindow, miniDialog }, foregroundHandle: HandleB);

        Assert.Equal(HandleA, anchor!.Value.Handle);
        Assert.Equal(maximizedMainWindow.Bounds, anchor.Value.Bounds);
    }

    [Fact]
    public void ResolveReAnchorsToASecondMaximizedPioneerWindowThatTakesForeground()
    {
        // Will has two Pioneers open, both maximized — that behavior
        // (from the 2026-09-25 fix) must survive the 2026-09-28
        // maximized-only change: a second maximized Pioneer window taking
        // foreground still steals the anchor immediately.
        var currentAnchor = new PioneerWindowAnchorRule.Candidate(Handle: HandleA, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(0, 0, 1920, 1040));
        var otherMaximizedPioneer = new PioneerWindowAnchorRule.Candidate(Handle: HandleB, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(1920, 0, 1920, 1040));

        var anchor = PioneerWindowAnchorRule.Resolve(HandleA, new[] { currentAnchor, otherMaximizedPioneer }, foregroundHandle: HandleB);

        Assert.Equal(HandleB, anchor!.Value.Handle);
        Assert.Equal(otherMaximizedPioneer.Bounds, anchor.Value.Bounds);
    }

    [Fact]
    public void ResolveKeepsCachedAnchorWhenForegroundIsNotAPioneerCandidateAtAll()
    {
        // Some other app (e.g. vaccine-assist's own window) took focus
        // briefly — since it's not even in the candidate list, the
        // sticky cached anchor must be unaffected (matches RxOverlay:
        // stay on the last Pioneer window rather than disappearing or
        // jumping).
        var mainWindow = new PioneerWindowAnchorRule.Candidate(Handle: HandleA, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(0, 0, 1920, 1040));
        var otherPioneerInstance = new PioneerWindowAnchorRule.Candidate(Handle: HandleB, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(1920, 0, 1920, 1040));
        var someUnrelatedForegroundWindow = new IntPtr(999);

        var anchor = PioneerWindowAnchorRule.Resolve(HandleA, new[] { mainWindow, otherPioneerInstance }, foregroundHandle: someUnrelatedForegroundWindow);

        Assert.Equal(HandleA, anchor!.Value.Handle);
    }

    [Fact]
    public void ResolveWithForegroundEqualToCachedHandleBehavesAsPlainSticky()
    {
        var mainWindow = new PioneerWindowAnchorRule.Candidate(Handle: HandleA, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(0, 0, 1920, 1040));

        var anchor = PioneerWindowAnchorRule.Resolve(HandleA, new[] { mainWindow }, foregroundHandle: HandleA);

        Assert.Equal(HandleA, anchor!.Value.Handle);
    }

    [Fact]
    public void ResolveDefaultForegroundHandleReproducesPlainStickyBehavior()
    {
        // Omitting foregroundHandle entirely (IntPtr.Zero default) must
        // be indistinguishable from a plain sticky Resolve call.
        var mainWindow = new PioneerWindowAnchorRule.Candidate(Handle: HandleA, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(0, 0, 1920, 1040));
        var otherPioneerInstance = new PioneerWindowAnchorRule.Candidate(Handle: HandleB, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(1920, 0, 1920, 1040));

        var anchor = PioneerWindowAnchorRule.Resolve(HandleA, new[] { mainWindow, otherPioneerInstance });

        Assert.Equal(HandleA, anchor!.Value.Handle);
    }

    [Fact]
    public void ResolveIgnoresAForegroundedNonPioneerHandleEvenWhenItEqualsAStaleValue()
    {
        // Foreground differs from cached but isn't among the candidates
        // at all (e.g. HandleC belongs to some unrelated app) — must
        // fall through to the cached handle, not to Choose().
        var mainWindow = new PioneerWindowAnchorRule.Candidate(Handle: HandleA, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(0, 0, 1920, 1040));
        var otherPioneerInstance = new PioneerWindowAnchorRule.Candidate(Handle: HandleB, IsVisible: true, IsMinimized: false, IsMaximized: true, Bounds: new Rectangle(1920, 0, 1920, 1040));

        var anchor = PioneerWindowAnchorRule.Resolve(HandleA, new[] { mainWindow, otherPioneerInstance }, foregroundHandle: HandleC);

        Assert.Equal(HandleA, anchor!.Value.Handle);
    }

    [Theory]
    [InlineData(0, 10)]
    [InlineData(10, 0)]
    [InlineData(-5, 10)]
    public void SaneWindowRectRequiresPositiveWidthAndHeight(int width, int height)
    {
        Assert.False(PioneerWindowAnchorRule.IsSaneWindowRect(new Rectangle(0, 0, width, height)));
    }

    [Fact]
    public void SaneWindowRectAcceptsAnyPositiveSize()
    {
        Assert.True(PioneerWindowAnchorRule.IsSaneWindowRect(new Rectangle(0, 0, 1, 1)));
    }
}
