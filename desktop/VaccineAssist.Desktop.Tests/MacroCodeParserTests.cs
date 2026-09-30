using VaccineAssist.Desktop.PioneerEntryAutomation;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-T41 R5 (item 3): MacroCodeParser.TryParse reverses cloud/lib/macro-codes.ts's
/// buildMacroCode ("&lt;short_code&gt;,&lt;lot&gt;,&lt;MMDDYYYY&gt;") — see
/// that class's own doc comment.
/// </summary>
public class MacroCodeParserTests
{
    [Fact]
    public void ParsesAllThreeSegments()
    {
        var parsed = MacroCodeParser.TryParse("shingrix1,LOT123,01152027");

        Assert.NotNull(parsed);
        Assert.Equal("shingrix1", parsed!.Value.ShortCode);
        Assert.Equal("LOT123", parsed.Value.LotNumber);
        Assert.Equal("01152027", parsed.Value.ExpirationMacroFormat);
    }

    [Fact]
    public void TrimsWhitespaceFromEverySegment()
    {
        var parsed = MacroCodeParser.TryParse(" shingrix1 , LOT123 , 01152027 ");

        Assert.NotNull(parsed);
        Assert.Equal("shingrix1", parsed!.Value.ShortCode);
        Assert.Equal("LOT123", parsed.Value.LotNumber);
        Assert.Equal("01152027", parsed.Value.ExpirationMacroFormat);
    }

    [Fact]
    public void MissingLotAndExpirationSegmentsDefaultToBlank()
    {
        // cloud/lib/macro-codes.ts's buildMacroCode always emits both
        // trailing segments (blank when the lot/exp are missing on file:
        // "flucelvaxmdv,,") -- this just also tolerates a short string
        // with fewer commas than that, rather than throwing.
        var parsed = MacroCodeParser.TryParse("flucelvaxmdv");

        Assert.NotNull(parsed);
        Assert.Equal("flucelvaxmdv", parsed!.Value.ShortCode);
        Assert.Equal("", parsed.Value.LotNumber);
        Assert.Equal("", parsed.Value.ExpirationMacroFormat);
    }

    [Fact]
    public void BlankLotAndExpirationSegmentsParseAsEmptyStrings()
    {
        var parsed = MacroCodeParser.TryParse("flucelvaxmdv,,");

        Assert.NotNull(parsed);
        Assert.Equal("flucelvaxmdv", parsed!.Value.ShortCode);
        Assert.Equal("", parsed.Value.LotNumber);
        Assert.Equal("", parsed.Value.ExpirationMacroFormat);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(",LOT123,01152027")]
    public void ReturnsNullForBlankOrMissingShortCode(string? macroText)
    {
        Assert.Null(MacroCodeParser.TryParse(macroText));
    }
}
