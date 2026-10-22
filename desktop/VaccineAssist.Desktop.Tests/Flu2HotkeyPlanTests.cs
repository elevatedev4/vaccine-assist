using System.Text.Json;
using VaccineAssist.Desktop.Hotkeys;
using VaccineAssist.Desktop.Logging;
using VaccineAssist.Desktop.Settings;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Will's hotkeys (V-Q11 2026-10-20, 2026-10-22): F = preferred flu for the age, X Flucelvax, D Fluad,
/// V mFLUSIVA, C = preferred COVID (location setting, Comirnaty by default), P/M unchanged. The plan turns
/// them into the CLASSIC letters the deployed cloud page understands. Synthetic ages only.
/// </summary>
public class Flu2HotkeyPlanTests
{
    [Theory]
    [InlineData(3, "f")]    // Flucelvax
    [InlineData(49, "f")]
    [InlineData(50, "l")]   // mFLUSIVA
    [InlineData(64, "l")]
    [InlineData(65, "d")]   // Fluad
    [InlineData(90, "d")]
    public void F_PicksThePreferredFluForTheAge(int age, string classicKey)
    {
        var plan = Flu2HotkeyPlan.For(age, "pfizer");
        Assert.Equal(classicKey, plan.Keys["f"].To);
        Assert.Null(plan.Keys["f"].Notice);
    }

    [Fact]
    public void F_IsNeverFluMist()
    {
        for (var age = 3; age <= 110; age++)
        {
            Assert.NotEqual("u", Flu2HotkeyPlan.SmartFlu(age).To); // U is FluMist's own key
        }
    }

    [Fact]
    public void F_UnderThree_OrWithoutAge_ShowsAMessageInsteadOfPicking()
    {
        Assert.Null(Flu2HotkeyPlan.For(2, "pfizer").Keys["f"].To);
        Assert.Contains("under age 3", Flu2HotkeyPlan.For(2, "pfizer").Keys["f"].Notice);
        Assert.Contains("age", Flu2HotkeyPlan.For(null, "pfizer").Keys["f"].Notice);
        Assert.Null(Flu2HotkeyPlan.For(null, "pfizer").Keys["f"].To);
    }

    [Theory]
    [InlineData(12, "pfizer", "p")]
    [InlineData(40, "pfizer", "p")]
    [InlineData(40, "moderna", "m")]
    [InlineData(12, "moderna", "m")]
    [InlineData(11, "pfizer", "3")]    // kids are Moderna 3-11 whatever the adult setting
    [InlineData(3, "moderna", "3")]
    public void C_PicksThePreferredCovidForTheAgeAndSetting(int age, string adultSetting, string classicKey)
    {
        Assert.Equal(classicKey, Flu2HotkeyPlan.For(age, adultSetting).Keys["c"].To);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("garbage")]
    public void C_DefaultsToPfizerComirnaty_WhenTheSettingIsMissingOrInvalid(string? setting)
    {
        Assert.Equal("p", Flu2HotkeyPlan.For(30, setting).Keys["c"].To);
    }

    [Fact]
    public void AppSettings_DefaultIsPfizer()
    {
        Assert.Equal("pfizer", new AppSettings().PreferredCovidAdult);
    }

    [Fact]
    public void C_UnderThree_OrWithoutAge_ShowsAMessage()
    {
        Assert.Contains("under age 3", Flu2HotkeyPlan.For(2, "pfizer").Keys["c"].Notice);
        Assert.Contains("age", Flu2HotkeyPlan.For(null, "pfizer").Keys["c"].Notice);
    }

    [Fact]
    public void FixedKeys_MapToTheClassicLettersOfTheirProducts()
    {
        var keys = Flu2HotkeyPlan.For(30, "pfizer").Keys;
        Assert.Equal("f", keys["x"].To); // Flucelvax
        Assert.Equal("l", keys["v"].To); // mFLUSIVA
        Assert.Equal("c", keys["a"].To); // Capvaxive moved from C
        Assert.Equal("v", keys["q"].To); // Vaqta moved from V
        Assert.False(keys.ContainsKey("d")); // D stays Fluad
        Assert.False(keys.ContainsKey("p")); // P stays Pfizer
        Assert.False(keys.ContainsKey("m")); // M stays Moderna
        Assert.False(keys.ContainsKey("u")); // U stays FluMist
    }

    [Fact]
    public void ReleasedClassicLetter_IsBlocked()
    {
        Assert.Contains("l", Flu2HotkeyPlan.For(30, "pfizer").Blocked); // mFLUSIVA's old key
    }

    [Fact]
    public void PreferredCovidFor_MatchesTheCloudRule()
    {
        Assert.Null(Flu2HotkeyPlan.PreferredCovidFor(2, "pfizer"));
        Assert.Equal("p", Flu2HotkeyPlan.PreferredCovidFor(12, "pfizer")!.ClassicKey);
        Assert.Equal("3", Flu2HotkeyPlan.PreferredCovidFor(11, "moderna")!.ClassicKey);
    }

    [Fact]
    public void Script_CarriesThePlanAsValidJson_AndEscapesNothingItShouldNot()
    {
        var plan = Flu2HotkeyPlan.For(55, "pfizer");
        var json = plan.ToJson();
        using var doc = JsonDocument.Parse(json);
        Assert.Equal("l", doc.RootElement.GetProperty("keys").GetProperty("f").GetProperty("to").GetString());
        Assert.Equal("l", doc.RootElement.GetProperty("blocked")[0].GetString());

        var script = Flu2HotkeyScript.Build(plan);
        Assert.Contains(json, script);
        Assert.DoesNotContain("__PLAN__", script);
    }
}

public class Flu2HotkeyGuardTests
{
    [Fact]
    public void EveryLetterTheRewriteTargetsIsInTheClassicGuardList()
    {
        // The page is trusted only while it still underlines these classic letters.
        var expected = new System.Collections.Generic.Dictionary<string, string>
        {
            ["flucelvax"] = "f", ["mflusiva"] = "l", ["fluad"] = "d", ["capvaxive"] = "c", ["vaqta"] = "v",
        };
        foreach (var label in Flu2HotkeyPlan.ClassicLabels)
        {
            Assert.Equal(expected[label.Match], label.Letter);
        }
        Assert.Equal(expected.Count, Flu2HotkeyPlan.ClassicLabels.Count);

        // Every key the fixed rewrites and F (all ages) can produce is a letter the guard covers.
        var covered = new System.Collections.Generic.HashSet<string>();
        foreach (var l in Flu2HotkeyPlan.ClassicLabels) covered.Add(l.Letter);
        for (var age = 3; age <= 100; age++)
        {
            Assert.Contains(Flu2HotkeyPlan.For(age, "pfizer").Keys["f"].To!, covered);
        }
        foreach (var key in new[] { "x", "v", "a", "q" })
        {
            Assert.Contains(Flu2HotkeyPlan.For(30, "pfizer").Keys[key].To!, covered);
        }
    }

    [Fact]
    public void ScriptDisablesRewritingAndReportsOnceWhenALabelLetterDiffers()
    {
        var plan = Flu2HotkeyPlan.For(30, "pfizer");
        var script = Flu2HotkeyScript.Build(plan);
        Assert.Contains("hotkey-guard", script);
        Assert.Contains("disabled = true", script);
        Assert.Contains("classic", plan.ToJson());
    }
}

public class FlowTimingTests
{
    [Fact]
    public void FormatLine_NamesTheFlowTheStepAndTheMilliseconds()
    {
        Assert.Equal("[Timing] Ctrl+Keypad 2 flu check: flu popup shown +87 ms",
            FlowTiming.FormatLine("Ctrl+Keypad 2 flu check", "flu popup shown", 87));
    }
}
