using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-T41 (Will's 2026-09-28 report): "It makes it to the priority screen
/// and enters 'Vaccine' as the priority, but fails to save it. Need to
/// push F12 after that, then continue." PriorityConfirmPlan.Order
/// documents the fixed attempt order
/// SendF3AndDismissPreEntryDialogsStep.TryConfirmDialog follows; this test
/// pins F12 as the FIRST attempt (the actual fix) and the rest of the
/// order as previously shipped, so a future edit that reorders/drops a
/// step is caught here instead of only discoverable live in Pioneer.
/// </summary>
public class PriorityConfirmPlanTests
{
    [Fact]
    public void F12IsTheFirstConfirmAttempt()
    {
        Assert.Equal(PriorityConfirmStep.F12, PriorityConfirmPlan.Order[0]);
    }

    [Fact]
    public void OrderIsExactlyF12ThenSaveButtonThenEnterThenAltO()
    {
        Assert.Equal(
            new[]
            {
                PriorityConfirmStep.F12,
                PriorityConfirmStep.InvokeSaveButton,
                PriorityConfirmStep.Enter,
                PriorityConfirmStep.AltO,
            },
            PriorityConfirmPlan.Order);
    }
}
