using VaccineAssist.Desktop.FluPreference;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Will 2026-10-22: "If someone picks flumist, just check the age range, don't do anything with preferred.
/// People who want flumist want flumist." FluMist's range is "age 2-49" (cloud macro-catalog.ts flumist,
/// vaccine-product-catalog.ts "FluMist (age 2-49)").
/// </summary>
public class FluMistRangeTests
{
    [Theory]
    [InlineData(2)]
    [InlineData(10)]
    [InlineData(30)]
    [InlineData(49)]
    public void InsideTheApprovedRange_NoPromptAtAll_EvenWhenAnotherFluIsPreferred(int age)
    {
        Assert.Null(FluPreferenceRules.Evaluate(age, "flumist"));
    }

    [Theory]
    [InlineData(1)]
    [InlineData(0)]
    [InlineData(50)]
    [InlineData(64)]
    [InlineData(65)]
    [InlineData(88)]
    public void OutsideTheApprovedRange_WarnsOnly_NoPreferredProduct(int age)
    {
        var prompt = FluPreferenceRules.Evaluate(age, "flumist");
        Assert.NotNull(prompt);
        Assert.True(prompt!.RangeWarningOnly);
        Assert.Contains("2", prompt.ApprovedNote);
        Assert.Contains("49", prompt.ApprovedNote);
        Assert.Empty(prompt.PreferredShortCodes); // nothing to swap to
    }

    [Fact]
    public void FluMistVariantCodes_AreRecognised()
    {
        Assert.True(FluPreferenceRules.IsFluMist("flumist"));
        Assert.True(FluPreferenceRules.IsFluMist("  FluMist2026 "));
        Assert.False(FluPreferenceRules.IsFluMist("flucelvaxmdv"));
        Assert.False(FluPreferenceRules.IsFluMist(null));
    }

    [Fact]
    public void OtherFluProducts_AreUnchanged()
    {
        Assert.NotNull(FluPreferenceRules.Evaluate(55, "flucelvaxmdv"));
        Assert.False(FluPreferenceRules.Evaluate(55, "flucelvaxmdv")!.RangeWarningOnly);
        Assert.Null(FluPreferenceRules.Evaluate(55, "mflusiva"));
    }

    [Fact]
    public void DescribeDecision_SaysFluMistIsNotComparedWithPreferred()
    {
        Assert.StartsWith("no prompt: FluMist", FluPreferenceRules.DescribeDecision(30, "flumist"));
        Assert.StartsWith("WARNING: FluMist", FluPreferenceRules.DescribeDecision(60, "flumist"));
    }
}
