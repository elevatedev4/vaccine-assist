namespace VaccineAssist.Desktop.Overlay;

/// <summary>
/// Pure decision behind whether the Pioneer overlay icon should be
/// visible right now (Will's 2026-09-29 thread message, verbatim:
/// "Vaccine assist desktop app: When pioneer is not focused, hide the
/// blue icon, just like we do with RxVerify.") — mirrors rx-verify's own
/// Integrated/IntegratedVisibilityGate.ShouldShowControlBox exactly:
/// "the control box stays visible any time PioneerRx is the foreground
/// application, REGARDLESS of maximized state ... matched by owning
/// PROCESS, not window title." No WPF/Win32 dependency, so it's directly
/// unit-testable (see PioneerOverlayVisibilityGateTests.cs) — the impure
/// half (PioneerMainWindowLocator.IsPioneerForegroundApp, EnumWindows/
/// GetForegroundWindow) gathers the inputs every ~250ms tick and hands
/// them here; see PioneerOverlayController.Tick for the live wiring.
///
/// Deliberately a SEPARATE question from PioneerWindowAnchorRule's own
/// "which Pioneer window does the icon anchor its POSITION to" — that
/// rule stays maximized-only and sticky (Will's 2026-09-28 ask: "it
/// doesn't pop on every little mini screen pioneer might pop up") so the
/// icon doesn't jump around; this gate only ever answers "show it at
/// all, or hide it," using the broader, non-maximized-only "is Pioneer
/// the app currently in front" signal — the same split rx-verify's own
/// ShouldShowBoxes (narrow) vs. ShouldShowControlBox (broad) uses.
/// </summary>
public static class PioneerOverlayVisibilityGate
{
    public static bool ShouldShow(bool settingEnabled, bool hasMainWindow, bool isMainWindowMinimized, bool isPioneerForegroundApp)
    {
        if (!settingEnabled) return false;
        if (!hasMainWindow || isMainWindowMinimized) return false;
        return isPioneerForegroundApp;
    }
}
