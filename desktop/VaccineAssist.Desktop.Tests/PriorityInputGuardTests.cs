using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-T41 ROUND 4 REVIEW FIX (BLOCKER 1 — safety reviewer): "after
/// TryBringToForeground there is NO re-check; Alt+Down is then sent blind.
/// If the focus switch silently failed, Alt+Down lands on Pioneer's main
/// New Rx form." PriorityInputGuard.CanSendInput is the pure decision half
/// of the fix — see SendF3AndDismissPreEntryDialogsStep.TryAuthorizeDialogInput
/// for the live wrapper that gathers these three booleans fresh, immediately
/// before every raw keystroke/click the Priority strategies send, and calls
/// this. These four cases are exactly the ones the reviewer's brief named:
/// not-alive refuses regardless of the other flags; alive+dialog-foreground
/// allows; alive+same-process-ComboLBox-popup-foreground allows (the popup
/// legitimately steals foreground while open); alive+neither-foreground
/// refuses (the dangerous case — input would land somewhere else, e.g.
/// Pioneer's main New Rx form).
/// </summary>
public class PriorityInputGuardTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public void NotAliveAlwaysRefusesRegardlessOfOtherFlags(bool dialogIsForeground, bool comboPopupForeground)
    {
        // dialogAliveAndVisible is always false here; the other two flags
        // are varied to prove neither can override a dead/hidden dialog.
        Assert.False(PriorityInputGuard.CanSendInput(
            dialogAliveAndVisible: false,
            dialogIsForeground: dialogIsForeground,
            foregroundIsSameProcessComboLBoxPopup: comboPopupForeground));
    }

    [Fact]
    public void AliveAndDialogIsForegroundAllows()
    {
        Assert.True(PriorityInputGuard.CanSendInput(
            dialogAliveAndVisible: true,
            dialogIsForeground: true,
            foregroundIsSameProcessComboLBoxPopup: false));
    }

    [Fact]
    public void AliveAndComboPopupIsForegroundAllows()
    {
        Assert.True(PriorityInputGuard.CanSendInput(
            dialogAliveAndVisible: true,
            dialogIsForeground: false,
            foregroundIsSameProcessComboLBoxPopup: true));
    }

    [Fact]
    public void AliveButNeitherForegroundRefuses()
    {
        // The dangerous case the reviewer flagged: dialog is alive, but
        // some OTHER window (e.g. Pioneer's main New Rx form) has focus.
        Assert.False(PriorityInputGuard.CanSendInput(
            dialogAliveAndVisible: true,
            dialogIsForeground: false,
            foregroundIsSameProcessComboLBoxPopup: false));
    }

    /// <summary>
    /// V-T41 ROUND 5 (Will's 2026-09-29 follow-up): CanConfirmDialog is
    /// the STRICT sibling used only for Save/confirm keystrokes (F12,
    /// Enter, Alt+O) — see its own doc comment. Unlike CanSendInput, a
    /// same-process ComboLBox popup being foreground is NEVER enough on
    /// its own: F12 sent to that popup is exactly the root cause this
    /// round fixes (Pioneer's combo list ignores F12), so confirm input
    /// requires the dialog itself, literally, to be foreground.
    /// </summary>
    [Fact]
    public void ConfirmDialogAliveAndDialogForegroundAllows()
    {
        Assert.True(PriorityInputGuard.CanConfirmDialog(dialogAliveAndVisible: true, dialogIsForeground: true));
    }

    [Fact]
    public void ConfirmDialogNotAliveRefusesEvenIfForeground()
    {
        Assert.False(PriorityInputGuard.CanConfirmDialog(dialogAliveAndVisible: false, dialogIsForeground: true));
    }

    [Fact]
    public void ConfirmDialogAliveButNotForegroundRefuses()
    {
        // The exact bug: a ComboLBox popup (or anything else) still has
        // foreground — F12 must NOT be sent, unlike CanSendInput's popup
        // allowance.
        Assert.False(PriorityInputGuard.CanConfirmDialog(dialogAliveAndVisible: true, dialogIsForeground: false));
    }

    /// <summary>
    /// V-T41 ROUND 6 (Will's 2026-09-29 11:14 app.log — the live UIA dump
    /// showed PioneerRx's real Priority dialog is an Edit search box with
    /// its own separate top-level popup window, class 'Auto-Suggest
    /// Dropdown', NOT a classic ComboBox/ComboLBox): IsRecognizedPopupWindowClass
    /// is the shared, pure classification every "is this popup safe to
    /// send to / safe to Escape-close" check in
    /// SendF3AndDismissPreEntryDialogsStep now goes through — see its own
    /// doc comment for why the set lives here in exactly one place.
    /// </summary>
    [Theory]
    [InlineData("ComboLBox")]
    [InlineData("comboLBOX")]
    [InlineData("Auto-Suggest Dropdown")]
    [InlineData("AUTO-SUGGEST DROPDOWN")]
    public void RecognizedPopupWindowClassesAreCaseInsensitiveMatches(string windowClass)
    {
        Assert.True(PriorityInputGuard.IsRecognizedPopupWindowClass(windowClass));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("WindowsForms10.Window.8.app.0.37e3228_r7_ad1")]
    [InlineData("Auto-Suggest")]
    [InlineData("ComboBox")]
    public void UnrecognizedOrMissingWindowClassesAreNotMatches(string? windowClass)
    {
        Assert.False(PriorityInputGuard.IsRecognizedPopupWindowClass(windowClass));
    }
}
