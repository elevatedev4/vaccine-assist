using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class FaxNumberNormalizerTests
{
    [Theory]
    [InlineData("555-555-0100", true)]
    [InlineData("5555550100", true)]
    [InlineData("(555) 555-0100", true)]
    [InlineData("15555550100", true)]
    public void TenOrElevenDigitNumbersAreValid(string input, bool expected)
    {
        Assert.Equal(expected, FaxNumberNormalizer.IsValid(input));
    }

    [Theory]
    [InlineData("555-0100")] // 7 digits
    [InlineData("25555550100")] // 11 digits not starting with 1
    [InlineData("")]
    [InlineData(null)]
    public void ShortOrMalformedNumbersAreInvalid(string? input)
    {
        Assert.False(FaxNumberNormalizer.IsValid(input));
    }

    [Fact]
    public void ToDialableOrNullReturnsDigitsOnlyForValidNumber()
    {
        Assert.Equal("5555550100", FaxNumberNormalizer.ToDialableOrNull("(555) 555-0100"));
    }

    [Fact]
    public void ToDialableOrNullReturnsNullForInvalidNumber()
    {
        Assert.Null(FaxNumberNormalizer.ToDialableOrNull("555-0100"));
    }

    [Fact]
    public void Last4ReturnsFinalFourDigits()
    {
        Assert.Equal("0100", FaxNumberNormalizer.Last4("(555) 555-0100"));
    }

    [Fact]
    public void Last4ReturnsWholeStringWhenShorterThanFour()
    {
        Assert.Equal("55", FaxNumberNormalizer.Last4("55"));
    }

    [Theory]
    [InlineData("5555550100", "+15555550100")]
    [InlineData("(555) 555-0100", "+15555550100")]
    [InlineData("15555550100", "+15555550100")]
    public void ToE164OrNullPrefixesPlusOneForValidNumbers(string input, string expected)
    {
        Assert.Equal(expected, FaxNumberNormalizer.ToE164OrNull(input));
    }

    [Theory]
    [InlineData("555-0100")] // 7 digits
    [InlineData("25555550100")] // 11 digits not starting with 1
    [InlineData("")]
    [InlineData(null)]
    public void ToE164OrNullReturnsNullForInvalidNumbers(string? input)
    {
        Assert.Null(FaxNumberNormalizer.ToE164OrNull(input));
    }
}
