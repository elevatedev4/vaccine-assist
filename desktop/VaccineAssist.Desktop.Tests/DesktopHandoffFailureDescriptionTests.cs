using VaccineAssist.Desktop.Views;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class DesktopHandoffFailureDescriptionTests
{
    [Fact]
    public void IncludesHttpStatusCodeWhenAvailable()
    {
        Assert.Equal(
            "WebErrorStatus=ConnectionAborted, HttpStatusCode=500",
            DesktopHandoffFailureDescription.Describe("ConnectionAborted", 500));
    }

    [Fact]
    public void OmitsHttpStatusCodeWhenNull()
    {
        Assert.Equal(
            "WebErrorStatus=Timeout",
            DesktopHandoffFailureDescription.Describe("Timeout", null));
    }

    [Fact]
    public void OmitsHttpStatusCodeWhenZero()
    {
        // 0 is a real (if unusual) value some non-HTTP failures could
        // report — it's still meaningfully different from "not available
        // at all" (null), so it must NOT be treated the same as omitted.
        Assert.Equal(
            "WebErrorStatus=Unknown, HttpStatusCode=0",
            DesktopHandoffFailureDescription.Describe("Unknown", 0));
    }
}
