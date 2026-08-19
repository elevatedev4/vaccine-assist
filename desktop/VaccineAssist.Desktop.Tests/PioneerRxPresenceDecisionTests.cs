using VaccineAssist.Desktop.Uia;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class PioneerRxPresenceDecisionTests
{
    [Theory]
    [InlineData(false, false, false)]
    [InlineData(true, false, true)]
    [InlineData(false, true, true)]
    [InlineData(true, true, true)]
    public void CombinesBothSignalsWithOr(bool foregroundTitleMatches, bool processIsRunning, bool expected)
    {
        Assert.Equal(expected, PioneerRxPresenceDecision.IsPresent(foregroundTitleMatches, processIsRunning));
    }
}
