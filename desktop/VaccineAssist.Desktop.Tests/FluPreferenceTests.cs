using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using VaccineAssist.Desktop.FluPreference;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>Flu preference rules (Will 2026-10-18): Flucelvax 3-49, mFLUSIVA 50-64, Fluad 65+ preferred; approved Flucelvax 3+, mFLUSIVA 50+, Fluad 65+. Synthetic data only.</summary>
public class FluPreferenceTests
{
    private static readonly DateOnly Today = new(2026, 10, 18);

    // ---- rule function: age x product ----

    [Theory]
    // Flucelvax selected
    [InlineData(2, "flucelvaxmdv", null)]                      // under 3: never prompts
    [InlineData(3, "flucelvaxmdv", null)]                      // preferred 3-49
    [InlineData(49, "flucelvaxpfs", null)]
    [InlineData(50, "flucelvaxmdv", "mFLUSIVA")]
    [InlineData(64, "flucelvaxpfs", "mFLUSIVA")]
    [InlineData(65, "flucelvaxmdv", "Fluad")]
    [InlineData(90, "flucelvaxpfs", "Fluad")]
    // mFLUSIVA selected
    [InlineData(2, "mflusiva", null)]
    [InlineData(3, "mflusiva", "Flucelvax")]
    [InlineData(49, "mflusiva", "Flucelvax")]
    [InlineData(50, "mflusiva", null)]
    [InlineData(64, "mflusiva", null)]
    [InlineData(65, "mflusiva", "Fluad")]
    [InlineData(90, "mflusiva", "Fluad")]
    // Fluad selected
    [InlineData(2, "fluad", null)]
    [InlineData(3, "fluad", "Flucelvax")]
    [InlineData(49, "fluad", "Flucelvax")]
    [InlineData(50, "fluad", "mFLUSIVA")]
    [InlineData(64, "fluad", "mFLUSIVA")]
    [InlineData(65, "fluad", null)]
    [InlineData(90, "fluad", null)]
    public void PromptsOnlyWhenNotThePreferredProductForTheAge(int age, string code, string? expectedPreferred)
    {
        var prompt = FluPreferenceRules.Evaluate(age, code);

        if (expectedPreferred is null)
        {
            Assert.Null(prompt);
        }
        else
        {
            Assert.NotNull(prompt);
            Assert.Equal(expectedPreferred, prompt!.PreferredName);
            Assert.Equal(age, prompt.AgeYears);
        }
    }

    [Theory]
    [InlineData(2, "mflusiva", null)]                 // under 3: no prompt at all
    [InlineData(3, "mflusiva", "mFLUSIVA is only approved for ages 50 and older.")]
    [InlineData(49, "mflusiva", "mFLUSIVA is only approved for ages 50 and older.")]
    [InlineData(64, "fluad", "Fluad is only approved for ages 65 and older.")]
    [InlineData(50, "fluad", "Fluad is only approved for ages 65 and older.")]
    [InlineData(3, "fluad", "Fluad is only approved for ages 65 and older.")]
    [InlineData(65, "mflusiva", null)]                // approved 50+, so no note even though Fluad is preferred
    [InlineData(90, "mflusiva", null)]
    [InlineData(50, "flucelvaxmdv", null)]            // Flucelvax is approved 3+ everywhere it can prompt
    [InlineData(90, "flucelvaxpfs", null)]
    public void ApprovedNoteOnlyWhenSelectedProductIsOutsideItsApprovedAges(int age, string code, string? expectedNote)
    {
        var prompt = FluPreferenceRules.Evaluate(age, code);

        if (age < 3)
        {
            Assert.Null(prompt);
            return;
        }
        Assert.NotNull(prompt);
        Assert.Equal(expectedNote, prompt!.ApprovedNote);
    }

    [Fact]
    public void ManualTestScenarioAge55FluadPromptsForMflusiva()
    {
        var prompt = FluPreferenceRules.Evaluate(55, "fluad");

        Assert.NotNull(prompt);
        Assert.Equal("Fluad", prompt!.SelectedName);
        Assert.Equal("mFLUSIVA", prompt.PreferredName);
        Assert.Equal("50–64", prompt.PreferredBandText);
        Assert.Equal(new[] { "mflusiva" }, prompt.PreferredShortCodes.ToArray());
        Assert.NotNull(prompt.ApprovedNote);
    }

    [Theory]
    [InlineData("shingrix1")]
    [InlineData("comirnaty12")]
    [InlineData("prevnar20")]
    [InlineData("mmr1")]
    [InlineData("boostrix")]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public void NonFluCodesNeverPrompt(string? code)
    {
        foreach (var age in new[] { 2, 3, 49, 50, 64, 65, 90 })
        {
            Assert.Null(FluPreferenceRules.Evaluate(age, code));
        }
    }

    [Theory]
    [InlineData("flucelvaxmdv", 55, "Flucelvax")]
    [InlineData("FLUCELVAXPFS", 55, "Flucelvax")]      // case-insensitive
    [InlineData(" fluad ", 30, "Fluad")]               // trimmed
    public void AnyFlucelvaxVariantCountsAsFlucelvax(string code, int age, string expectedSelected)
    {
        var prompt = FluPreferenceRules.Evaluate(age, code);
        Assert.NotNull(prompt);
        Assert.Equal(expectedSelected, prompt!.SelectedName);
    }

    [Theory]
    [InlineData("afluriapfs", "Afluria")]
    [InlineData("fluzonehd", "Fluzone High-Dose")]
    [InlineData("flumist", "FluMist")]
    public void OtherFluProductsPromptToTheAgePreferredWithNoApprovedNote(string code, string expectedName)
    {
        var prompt = FluPreferenceRules.Evaluate(40, code);

        Assert.NotNull(prompt);
        Assert.Equal(expectedName, prompt!.SelectedName);
        Assert.Equal("Flucelvax", prompt.PreferredName);
        Assert.Null(prompt.ApprovedNote);
        Assert.Null(FluPreferenceRules.Evaluate(2, code));
    }

    [Fact]
    public void RuleDataMatchesWillsNumbers()
    {
        var byName = FluPreferenceRules.Products.ToDictionary(p => p.DisplayName);

        Assert.Equal((3, 3, 49), (byName["Flucelvax"].ApprovedMinAge, byName["Flucelvax"].PreferredMinAge, byName["Flucelvax"].PreferredMaxAge!.Value));
        Assert.Equal((50, 50, 64), (byName["mFLUSIVA"].ApprovedMinAge, byName["mFLUSIVA"].PreferredMinAge, byName["mFLUSIVA"].PreferredMaxAge!.Value));
        Assert.Equal((65, 65), (byName["Fluad"].ApprovedMinAge, byName["Fluad"].PreferredMinAge));
        Assert.Null(byName["Fluad"].PreferredMaxAge);
        Assert.Equal(new[] { "flucelvaxmdv", "flucelvaxpfs" }, byName["Flucelvax"].PreferredShortCodes.ToArray());
    }

    // ---- code swap ----

    private static Vaccine V(string shortCode, string name, bool active = true) =>
        new() { Id = Guid.NewGuid(), ShortCode = shortCode, Name = name, Active = active };

    private static Lot L(Vaccine v, string lot, DateOnly? exp, string status = "active", DateOnly? bud = null) =>
        new() { Id = Guid.NewGuid(), VaccineId = v.Id, LotNumber = lot, Expiration = exp, Status = status, BeyondUseDate = bud };

    [Fact]
    public void PreferredFlucelvaxPicksMdvFirstThenPfs()
    {
        var pfs = V("flucelvaxpfs", "Flucelvax PFS");
        var mdv = V("flucelvaxmdv", "Flucelvax MDV");
        var prompt = FluPreferenceRules.Evaluate(30, "fluad")!;

        Assert.Same(mdv, FluPreferenceResolver.FindPreferredVaccine(new[] { pfs, mdv }, prompt));
        Assert.Same(pfs, FluPreferenceResolver.FindPreferredVaccine(new[] { pfs, V("flucelvaxmdv", "Flucelvax MDV", active: false) }, prompt));
    }

    [Fact]
    public void PreferredIsNullWhenNotOnFileOrNotActive()
    {
        var prompt = FluPreferenceRules.Evaluate(55, "fluad")!; // prefers mFLUSIVA

        Assert.Null(FluPreferenceResolver.FindPreferredVaccine(new[] { V("fluad", "Fluad") }, prompt));
        Assert.Null(FluPreferenceResolver.FindPreferredVaccine(new[] { V("mflusiva", "mFLUSIVA", active: false) }, prompt));
    }

    [Fact]
    public void SwappedMacroCodeIsParsedByTheEntryAutomationAndUsesThePreferredVaccineAndLot()
    {
        var mflusiva = V("mflusiva", "mFLUSIVA 2026-27");
        var lot = L(mflusiva, "TESTLOT42", new DateOnly(2027, 3, 9));

        var code = FluPreferenceResolver.BuildSwappedMacroCode(mflusiva, lot);
        Assert.Equal("mflusiva,TESTLOT42,03092027", code);

        var parsed = MacroCodeParser.TryParse(code);
        Assert.NotNull(parsed);
        Assert.Equal("mflusiva", parsed!.Value.ShortCode);
        Assert.Equal("TESTLOT42", parsed.Value.LotNumber);
        Assert.Equal("03092027", parsed.Value.ExpirationMacroFormat);
        // ...which the existing resolver maps to the PREFERRED vaccine row (not the originally picked one).
        var resolved = MacroCodeVaccineResolver.FindByShortCode(new[] { V("fluad", "Fluad"), mflusiva }, parsed.Value.ShortCode);
        Assert.Same(mflusiva, resolved);
    }

    [Fact]
    public void CurrentLotIsEarliestExpiringActiveLotWithUndatedLast()
    {
        var v = V("fluad", "Fluad");
        var late = L(v, "LATE", new DateOnly(2027, 6, 1));
        var early = L(v, "EARLY", new DateOnly(2027, 1, 1));
        var undated = L(v, "NODATE", null);
        var depleted = L(v, "GONE", new DateOnly(2026, 11, 1), status: "depleted");

        Assert.Same(early, FluPreferenceResolver.PickCurrentLot(new[] { undated, late, depleted, early }));
        Assert.Same(undated, FluPreferenceResolver.PickCurrentLot(new[] { undated, depleted }));
        Assert.Null(FluPreferenceResolver.PickCurrentLot(new[] { depleted }));
    }

    [Fact]
    public void LotProblemFlagsExpiredBeyondUseMissingExpirationAndBlankLot()
    {
        var v = V("fluad", "Fluad");

        Assert.Null(FluPreferenceResolver.LotProblem(L(v, "OK", Today.AddDays(30)), Today));
        Assert.Null(FluPreferenceResolver.LotProblem(L(v, "TODAY", Today), Today)); // expires today: still usable (strict <)
        Assert.Contains("expired", FluPreferenceResolver.LotProblem(L(v, "OLD", Today.AddDays(-1)), Today));
        Assert.Contains("beyond-use", FluPreferenceResolver.LotProblem(L(v, "BUD", Today.AddDays(30), bud: Today), Today));
        Assert.Contains("no expiration", FluPreferenceResolver.LotProblem(L(v, "NOEXP", null), Today));
        Assert.Contains("no lot number", FluPreferenceResolver.LotProblem(L(v, "  ", Today.AddDays(30)), Today));
    }

    // ---- end to end through the API fake ----

    [Fact]
    public async Task ResolvePreferredAsyncReturnsThePreferredVaccineWithItsOwnLot()
    {
        var api = new FakeVaccineApiService();
        var fluad = V("fluad", "Fluad");
        var mflusiva = V("mflusiva", "mFLUSIVA");
        api.Vaccines.AddRange(new[] { fluad, mflusiva });
        api.LotsByVaccineId[fluad.Id] = new List<Lot> { L(fluad, "FLUADLOT", Today.AddDays(90)) };
        api.LotsByVaccineId[mflusiva.Id] = new List<Lot> { L(mflusiva, "MRNALOT", new DateOnly(2027, 2, 14)) };
        var prompt = FluPreferenceRules.Evaluate(55, "fluad")!;

        var result = await FluPreferenceResolver.ResolvePreferredAsync(api, prompt, Today);

        Assert.True(result.IsAvailable);
        Assert.Equal(mflusiva.Id, result.Choice!.Vaccine.Id);
        Assert.Equal("mflusiva,MRNALOT,02142027", result.Choice.MacroCode); // NOT Fluad's lot
    }

    [Fact]
    public async Task ResolvePreferredAsyncExplainsWhyThePreferredCannotBeEntered()
    {
        var prompt = FluPreferenceRules.Evaluate(55, "fluad")!;

        var notOnFile = await FluPreferenceResolver.ResolvePreferredAsync(new FakeVaccineApiService(), prompt, Today);
        Assert.False(notOnFile.IsAvailable);
        Assert.Contains("mFLUSIVA", notOnFile.UnavailableReason);
        Assert.Contains("active vaccine", notOnFile.UnavailableReason);

        var api = new FakeVaccineApiService();
        var mflusiva = V("mflusiva", "mFLUSIVA");
        api.Vaccines.Add(mflusiva);
        var noLot = await FluPreferenceResolver.ResolvePreferredAsync(api, prompt, Today);
        Assert.False(noLot.IsAvailable);
        Assert.Contains("no active lot", noLot.UnavailableReason);

        api.LotsByVaccineId[mflusiva.Id] = new List<Lot> { L(mflusiva, "STALE", Today.AddDays(-5)) };
        var expired = await FluPreferenceResolver.ResolvePreferredAsync(api, prompt, Today);
        Assert.False(expired.IsAvailable);
        Assert.Contains("expired", expired.UnavailableReason);
    }

    [Fact]
    public async Task SlowLookupTimesOutAsUnavailable()
    {
        var api = new FakeVaccineApiService();
        var mflusiva = V("mflusiva", "mFLUSIVA");
        api.Vaccines.Add(mflusiva);
        api.LotsByVaccineId[mflusiva.Id] = new List<Lot> { L(mflusiva, "SLOW", Today.AddDays(30)) };
        api.DelayNextGetLotsCall = new TaskCompletionSource<bool>(); // never completes
        var prompt = FluPreferenceRules.Evaluate(55, "fluad")!;

        var result = await FluPreferenceResolver.ResolvePreferredWithTimeoutAsync(api, prompt, Today, TimeSpan.FromMilliseconds(150));

        Assert.False(result.IsAvailable);
        Assert.Contains("in time", result.UnavailableReason);
    }

    [Fact]
    public async Task LookupWithinTheTimeoutStillSucceeds()
    {
        var api = new FakeVaccineApiService();
        var mflusiva = V("mflusiva", "mFLUSIVA");
        api.Vaccines.Add(mflusiva);
        api.LotsByVaccineId[mflusiva.Id] = new List<Lot> { L(mflusiva, "FAST", Today.AddDays(30)) };
        var prompt = FluPreferenceRules.Evaluate(55, "fluad")!;

        var result = await FluPreferenceResolver.ResolvePreferredWithTimeoutAsync(api, prompt, Today, TimeSpan.FromSeconds(10));

        Assert.True(result.IsAvailable);
    }

    // ---- [FluPrompt] log line: says why a prompt did or did not appear ----

    [Theory]
    [InlineData(55, "fluad", "PROMPT: 'fluad' (Fluad) is not preferred at age 55; preferred is mFLUSIVA")]
    [InlineData(65, "fluzonehd", "PROMPT: 'fluzonehd' (Fluzone High-Dose) is not preferred at age 65; preferred is Fluad")]
    [InlineData(30, "flucelvaxpfs", "no prompt: 'flucelvaxpfs' already is the preferred flu vaccine (Flucelvax) for age 30")]
    [InlineData(2, "fluad", "no prompt: age 2 is under 3, no preferred flu vaccine ('fluad')")]
    [InlineData(40, "shingrix", "no prompt: 'shingrix' is not a flu vaccine code (age 40)")]
    public void DescribeDecision_StatesWhyAPromptDidOrDidNotAppear(int age, string code, string expected)
    {
        Assert.Equal(expected, FluPreferenceRules.DescribeDecision(age, code));
    }

    [Theory]
    [InlineData(2, "fluad")]
    [InlineData(3, "mflusiva")]
    [InlineData(50, "flucelvaxmdv")]
    [InlineData(65, "mflusiva")]
    [InlineData(30, "flucelvaxmdv")]
    [InlineData(30, "shingrix1")]
    public void DescribeDecision_AgreesWithEvaluate(int age, string code)
    {
        var prompts = FluPreferenceRules.Evaluate(age, code) is not null;
        Assert.Equal(prompts, FluPreferenceRules.DescribeDecision(age, code).StartsWith("PROMPT:", StringComparison.Ordinal));
    }
}
