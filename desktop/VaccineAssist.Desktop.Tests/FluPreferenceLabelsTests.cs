using VaccineAssist.Desktop.FluPreference;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>Flu popup button wording (Will 2026-10-30): "Switch" when recommending the preferred product, "Proceed" otherwise. Synthetic data only.</summary>
public class FluPreferenceLabelsTests
{
    [Fact]
    public void RecommendedSwitch_SaysSwitchToProduct()
    {
        Assert.Equal("Switch to mFLUSIVA", FluPreferenceLabels.ConfirmButtonText(true, "mFLUSIVA"));
    }

    [Fact]
    public void NoSwitchRecommended_StaysProceedWithProduct()
    {
        Assert.Equal("Proceed with Flucelvax", FluPreferenceLabels.ConfirmButtonText(false, "Flucelvax"));
    }
}
