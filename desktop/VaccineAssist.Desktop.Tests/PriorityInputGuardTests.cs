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
}
