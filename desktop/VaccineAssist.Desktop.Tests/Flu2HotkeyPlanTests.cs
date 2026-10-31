using System.Linq;
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

/// <summary>
/// Will 2026-10-30: "The hotkeys for the vaccines should appear as underlined letters in the word, not as
/// [X] brackets after. And add the F and C hotkey information by underlining F in Flu ... and putting an
/// explainer text after." Synthetic ages only.
/// </summary>
public class HotkeyLabelTests
{
    [Theory]
    [InlineData("flucelvax", "X", 8)]  // last letter
    [InlineData("mflusiva", "V", 6)]
    [InlineData("capvaxive", "A", 1)]  // first A, not the later one
    [InlineData("vaqta", "Q", 2)]
    [InlineData("Flu", "F", 0)]
    [InlineData("COVID", "C", 0)]
    [InlineData("COVID", "v", 2)]      // key case does not matter
    public void UnderlineIndex_IsTheFirstCaseInsensitiveOccurrence(string name, string key, int expected)
    {
        Assert.Equal(expected, HotkeyLabel.UnderlineIndex(name, key));
    }

    [Theory]
    [InlineData("fluad", "Z")]   // letter not in the name -> fallback badge
    [InlineData("fluad", "")]
    [InlineData("fluad", "ab")]
    [InlineData("fluad", null)]
    [InlineData("", "f")]
    [InlineData(null, "f")]
    public void UnderlineIndex_IsMinusOneWhenThereIsNothingToUnderline(string? name, string? key)
    {
        Assert.Equal(-1, HotkeyLabel.UnderlineIndex(name, key));
    }

    [Fact]
    public void EveryRelabelledProductHasItsKeyLetterInItsName()
    {
        var relabel = Flu2HotkeyPlan.For(30, "pfizer").Relabel;
        Assert.Equal(new[] { "flucelvax", "mflusiva", "capvaxive", "vaqta" }, relabel.Select(r => r.Match));
        foreach (var r in relabel)
        {
            Assert.True(r.At >= 0, r.Match + " has no letter " + r.Key + " to underline");
            Assert.Equal(char.ToLowerInvariant(r.Key[0]), r.Match[r.At]);
        }
    }

    [Fact]
    public void RelabelKeys_MatchTheFixedKeyMap()
    {
        // The underlined letter must be the key that actually works: X Flucelvax, V mFLUSIVA, A Capvaxive, Q Vaqta.
        var plan = Flu2HotkeyPlan.For(30, "pfizer");
        var classic = new System.Collections.Generic.Dictionary<string, string>
        {
            ["flucelvax"] = "f", ["mflusiva"] = "l", ["capvaxive"] = "c", ["vaqta"] = "v",
        };
        foreach (var r in plan.Relabel)
        {
            Assert.Equal(classic[r.Match], plan.Keys[r.Key.ToLowerInvariant()].To);
        }
    }

    [Fact]
    public void Hints_UnderlineFInFluAndCInCovid_WithExplainerText()
    {
        var hints = Flu2HotkeyPlan.For(40, "pfizer").Hints;
        Assert.Equal(2, hints.Count);

        var flu = hints.Single(h => h.Match == "flu");
        Assert.Equal("F", flu.Key);
        Assert.Equal(0, flu.At);
        Assert.Contains("press F", flu.Text);
        Assert.Contains("preferred flu", flu.Text);

        var covid = hints.Single(h => h.Match == "covid");
        Assert.Equal("C", covid.Key);
        Assert.Equal(0, covid.At);
        Assert.Contains("press C", covid.Text);
        Assert.Contains("preferred COVID", covid.Text);
    }

    [Fact]
    public void Hints_WithoutAge_SayHowToGetOne()
    {
        var hints = Flu2HotkeyPlan.For(null, "pfizer").Hints;
        Assert.Equal(2, hints.Count);
        Assert.All(hints, h => Assert.Contains("Ctrl+Keypad 2", h.Text));
    }

    [Fact]
    public void Hints_UnderThree_AreOmitted()
    {
        Assert.Empty(Flu2HotkeyPlan.For(2, "pfizer").Hints);
    }

    [Fact]
    public void Script_NoLongerStylesBracketsAsTheNormalPath()
    {
        var script = Flu2HotkeyScript.Build(Flu2HotkeyPlan.For(30, "pfizer"));
        Assert.Contains("CSS.highlights", script);          // underline inside the name
        Assert.Contains("::highlight(va-hotkey)", script);
        Assert.Contains("data-va-hint", script);            // Flu/COVID explainer
        Assert.Contains("\"at\":8", script);               // flucelvax: the X
        Assert.Contains("[data-va-key]::after", script);    // bracket kept only as the fallback
        Assert.Contains("rl.at >= 0", script);
    }

    [Fact]
    public void Script_ServesTheHintsAndRelabelsAsValidJson()
    {
        var plan = Flu2HotkeyPlan.For(70, "pfizer");
        using var doc = JsonDocument.Parse(plan.ToJson());
        var hints = doc.RootElement.GetProperty("hints");
        Assert.Equal(2, hints.GetArrayLength());
        Assert.Equal("flu", hints[0].GetProperty("match").GetString());
        Assert.StartsWith("\u2014 press F", hints[0].GetProperty("text").GetString());
        Assert.Equal(8, doc.RootElement.GetProperty("relabel")[0].GetProperty("at").GetInt32());
    }

    [Fact]
    public void Script_IsDefensive_EveryStageIsWrappedAndGuardsMissingElements()
    {
        var script = Flu2HotkeyScript.Build(Flu2HotkeyPlan.For(30, "pfizer"));
        // relabel / clearLabels / start / letterRange / highlightApi each swallow their own failures.
        Assert.True(CountOf(script, "catch (err)") >= 6);
        Assert.Contains("(cfg.hints || [])", script);
        Assert.Contains("if (!p) continue;", script);
        Assert.Contains("clearLabels();", script);   // guard trip removes labels too
    }

    private static int CountOf(string text, string needle)
    {
        var count = 0;
        for (var i = text.IndexOf(needle, System.StringComparison.Ordinal); i >= 0; i = text.IndexOf(needle, i + 1, System.StringComparison.Ordinal)) count++;
        return count;
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
