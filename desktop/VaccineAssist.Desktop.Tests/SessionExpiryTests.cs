using System;
using VaccineAssist.Desktop.Settings;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Unit tests for SessionExpiry.IsValid — the pure 90-day math backing
/// the persisted sign-in (Will, 2026-09-13: "make that last for 90 days
/// without requiring a login again, even if the program is restarted of
/// course"). Mirrors AutoLoginDecisionTests.cs's style: no IO, no DPAPI,
/// no WPF — just the boundary math.
/// </summary>
public class SessionExpiryTests
{
    [Fact]
    public void ValidRightAfterIssue()
    {
        var now = new DateTime(2026, 9, 13, 12, 0, 0, DateTimeKind.Utc);
        Assert.True(SessionExpiry.IsValid(issuedAtUtc: now, nowUtc: now));
    }

    [Fact]
    public void ValidOneDayBeforeTheLimit()
    {
        var issuedAt = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        var now = issuedAt.AddDays(SessionExpiry.MaxAgeDays - 1);
        Assert.True(SessionExpiry.IsValid(issuedAt, now));
    }

    [Fact]
    public void InvalidExactlyAtTheLimit()
    {
        var issuedAt = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        var now = issuedAt.AddDays(SessionExpiry.MaxAgeDays);
        Assert.False(SessionExpiry.IsValid(issuedAt, now));
    }

    [Fact]
    public void InvalidWellPastTheLimit()
    {
        var issuedAt = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        var now = issuedAt.AddDays(SessionExpiry.MaxAgeDays + 30);
        Assert.False(SessionExpiry.IsValid(issuedAt, now));
    }

    [Fact]
    public void InvalidWhenIssuedInTheFuture()
    {
        // Guards against a clock rollback (or a corrupt/tampered file)
        // granting an even-longer session than intended.
        var now = new DateTime(2026, 9, 13, 12, 0, 0, DateTimeKind.Utc);
        var issuedAt = now.AddDays(1);
        Assert.False(SessionExpiry.IsValid(issuedAt, now));
    }
}
