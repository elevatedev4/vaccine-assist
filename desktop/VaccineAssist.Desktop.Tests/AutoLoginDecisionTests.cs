using VaccineAssist.Desktop.Settings;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class AutoLoginDecisionTests
{
    [Fact]
    public void ReturnsFalseWhenConfigIsNull()
    {
        Assert.False(AutoLoginDecision.ShouldAttemptAutoLogin(null));
    }

    [Fact]
    public void ReturnsFalseWhenEmailIsBlank()
    {
        var config = new AutoLoginConfig { Email = "   ", Password = "hunter2" };
        Assert.False(AutoLoginDecision.ShouldAttemptAutoLogin(config));
    }

    [Fact]
    public void ReturnsFalseWhenPasswordIsBlank()
    {
        var config = new AutoLoginConfig { Email = "pharmacy@orchardsdrug.com", Password = "" };
        Assert.False(AutoLoginDecision.ShouldAttemptAutoLogin(config));
    }

    [Fact]
    public void ReturnsTrueWhenBothEmailAndPasswordAreSet()
    {
        var config = new AutoLoginConfig { Email = "pharmacy@orchardsdrug.com", Password = "hunter2" };
        Assert.True(AutoLoginDecision.ShouldAttemptAutoLogin(config));
    }
}
