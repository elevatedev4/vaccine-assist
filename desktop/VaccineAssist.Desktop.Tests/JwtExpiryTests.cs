using System;
using System.Text;
using VaccineAssist.Desktop.Services;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class JwtExpiryTests
{
    private static string B64(string json) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(json)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    [Fact]
    public void ReadsTheExpClaim()
    {
        var jwt = $"{B64("{\"alg\":\"none\"}")}.{B64("{\"sub\":\"u\",\"exp\":1790000000}")}.sig";

        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(1790000000).UtcDateTime, JwtExpiry.TryGetExpiryUtc(jwt));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("access")]
    [InlineData("a.b.c")]
    [InlineData("a.b")]
    public void UnparseableTokensReturnNull(string? jwt)
    {
        Assert.Null(JwtExpiry.TryGetExpiryUtc(jwt));
    }

    [Fact]
    public void PayloadWithoutExpReturnsNull()
    {
        var jwt = $"{B64("{}")}.{B64("{\"sub\":\"u\"}")}.sig";

        Assert.Null(JwtExpiry.TryGetExpiryUtc(jwt));
    }
}
