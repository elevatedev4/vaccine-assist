using VaccineAssist.Desktop.Services;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>The access-token push and the WebView2 navigation guard both
/// hinge on this check: only the configured cloud origin qualifies.</summary>
public class CloudOriginPolicyTests
{
    private const string Cloud = "https://vaccine-assist.example.test";

    [Theory]
    [InlineData("https://vaccine-assist.example.test/")]
    [InlineData("https://vaccine-assist.example.test/macro-codes?embed=1")]
    [InlineData("HTTPS://VACCINE-ASSIST.EXAMPLE.TEST/lots")]
    public void SameSchemeHostAndPortIsTheCloudOrigin(string url)
    {
        Assert.True(CloudOriginPolicy.IsCloudOrigin(url, Cloud));
        Assert.True(CloudOriginPolicy.IsCloudOrigin(url, Cloud + "/"));
    }

    [Theory]
    [InlineData("https://evil.example.test/")]
    [InlineData("https://vaccine-assist.example.test.evil.test/")]
    [InlineData("http://vaccine-assist.example.test/")] // scheme differs
    [InlineData("https://vaccine-assist.example.test:8443/")] // port differs
    [InlineData("about:blank")]
    [InlineData("data:text/html,hi")]
    [InlineData("/relative/path")]
    [InlineData("")]
    [InlineData(null)]
    public void AnythingElseIsNotTheCloudOrigin(string? url)
    {
        Assert.False(CloudOriginPolicy.IsCloudOrigin(url, Cloud));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not a url")]
    public void ABlankOrInvalidConfiguredBaseMatchesNothing(string? cloud)
    {
        Assert.False(CloudOriginPolicy.IsCloudOrigin("https://vaccine-assist.example.test/", cloud));
    }
}
