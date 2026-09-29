using System;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>V-T65 R5 follow-up (coordinator, 2026-09-29): Send History's
/// Date column binds RunAtLocal (not RunAtUtc directly) so it displays in
/// local time.</summary>
public class FaxRunSummaryTests
{
    [Fact]
    public void RunAtLocalIsRunAtUtcConvertedToLocalTime()
    {
        var summary = new FaxRunSummary { RunAtUtc = new DateTime(2026, 9, 29, 18, 30, 0, DateTimeKind.Utc) };

        Assert.Equal(summary.RunAtUtc.ToLocalTime(), summary.RunAtLocal);
    }
}
