using System.Linq;
using VaccineAssist.Desktop.Models;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// The single shared "Preferred COVID vaccine (12+)" menu definition used by both the
/// tray icon menu and the blue Pioneer icon menu (the WinForms/WPF glue itself is not
/// unit tested, same as TrayMenuBuilderTests).
/// </summary>
public class PreferredCovidMenuTests
{
    [Fact]
    public void TitleAndOptionsAreTheOnesBothMenusShow()
    {
        Assert.Equal("Preferred COVID vaccine (12+)", PreferredCovidMenu.Title);
        Assert.Equal(
            new[] { ("pfizer", "Pfizer (Comirnaty)"), ("moderna", "Moderna (Mnexspike)") },
            PreferredCovidMenu.Options.Select(o => (o.Value, o.Label)).ToArray());
    }

    [Theory]
    [InlineData("pfizer", "pfizer")]
    [InlineData("moderna", "moderna")]
    [InlineData("Moderna", "moderna")]
    [InlineData("  MODERNA ", "moderna")]
    [InlineData("", "pfizer")]
    [InlineData(null, "pfizer")]
    [InlineData("novavax", "pfizer")]
    public void SelectedFollowsTheStoredSettingAndDefaultsToPfizer(string? current, string expected)
    {
        Assert.Equal(expected, PreferredCovidMenu.Selected(current));
    }

    [Theory]
    [InlineData("pfizer")]
    [InlineData("moderna")]
    [InlineData(null)]
    [InlineData("junk")]
    public void ExactlyOneOptionIsCheckedForAnySetting(string? current)
    {
        var checkedValues = PreferredCovidMenu.Options
            .Where(o => PreferredCovidMenu.IsChecked(o.Value, current))
            .Select(o => o.Value)
            .ToArray();
        Assert.Single(checkedValues);
        Assert.Equal(PreferredCovidMenu.Selected(current), checkedValues[0]);
    }

    [Fact]
    public void EveryOptionValueIsAcceptedByTheSettingNormalizer()
    {
        foreach (var option in PreferredCovidMenu.Options)
        {
            Assert.Equal(option.Value, PreferredCovidSetting.NormalizeAdult(option.Value));
        }
    }
}
