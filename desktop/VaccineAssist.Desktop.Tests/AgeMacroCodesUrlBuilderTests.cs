using VaccineAssist.Desktop.Views;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// AgeMacroCodesUrlBuilder itself needs no WPF Window (see its own doc
/// comment), so it's covered here by fast xUnit tests, same "pure half"
/// split as AgePromptInputTests. Confirms the &amp;embed=1 param name
/// matches MacroCodesWindow's existing (Ctrl+Keypad 8) BuildMacroCodesUrl
/// exactly, plus the new &amp;age= filter param.
///
/// 2026-09-25 round 2: years-only now (months dropped per Will's brief).
/// The URL must never contain "ageMonths".
/// </summary>
public class AgeMacroCodesUrlBuilderTests
{
    [Fact]
    public void BuildUrl_AppendsEmbedAndAge()
    {
        var url = AgeMacroCodesUrlBuilder.BuildUrl("https://vaccine-assist.vercel.app", 7);

        Assert.Equal("https://vaccine-assist.vercel.app/macro-codes?embed=1&age=7", url);
        Assert.DoesNotContain("ageMonths", url);
    }

    [Fact]
    public void BuildUrl_TrimsTrailingSlashOnBaseUrl()
    {
        var url = AgeMacroCodesUrlBuilder.BuildUrl("https://vaccine-assist.vercel.app/", 3);

        Assert.Equal("https://vaccine-assist.vercel.app/macro-codes?embed=1&age=3", url);
        Assert.DoesNotContain("ageMonths", url);
    }

    [Fact]
    public void BuildUrl_NullBaseUrl_StillProducesARelativePath()
    {
        var url = AgeMacroCodesUrlBuilder.BuildUrl(null, 5);

        Assert.Equal("/macro-codes?embed=1&age=5", url);
        Assert.DoesNotContain("ageMonths", url);
    }
}
