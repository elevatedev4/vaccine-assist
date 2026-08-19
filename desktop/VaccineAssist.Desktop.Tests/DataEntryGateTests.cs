using System.Collections.Generic;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class DataEntryGateTests
{
    [Fact]
    public void NullResultBlocksEntryWithNoMessage()
    {
        var decision = DataEntryGate.Evaluate(null);

        Assert.False(decision.CanEnterIntoPioneer);
        Assert.Null(decision.BlockMessage);
    }

    [Fact]
    public void BlockedStatusBlocksEntryAndSurfacesReasons()
    {
        var result = new EligibilityResult
        {
            Status = "blocked",
            Reasons = new List<string> { "Patient age 1 is below the minimum age of 6 months." },
        };

        var decision = DataEntryGate.Evaluate(result);

        Assert.False(decision.CanEnterIntoPioneer);
        Assert.Contains("below the minimum age", decision.BlockMessage);
    }

    [Fact]
    public void WarningStatusAllowsEntry()
    {
        // Same convention EntryViewModel already documents: a warning
        // (e.g. unknown pregnancy status) is staff judgment, not a hard
        // stop.
        var result = new EligibilityResult { Status = "warning", Warnings = new List<string> { "Confirm not pregnant." } };

        var decision = DataEntryGate.Evaluate(result);

        Assert.True(decision.CanEnterIntoPioneer);
        Assert.Null(decision.BlockMessage);
    }

    [Fact]
    public void AllowedStatusAllowsEntry()
    {
        var result = new EligibilityResult { Status = "allowed" };

        var decision = DataEntryGate.Evaluate(result);

        Assert.True(decision.CanEnterIntoPioneer);
    }
}
