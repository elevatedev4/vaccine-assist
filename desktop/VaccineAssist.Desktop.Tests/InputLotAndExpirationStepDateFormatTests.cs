using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// ToPioneerDateFormat converts Models.Lot.ExpirationMacroFormat's
/// MMDDYYYY to the M/d/yyyy shape confirmed against the live UIA dump's
/// uxLotExpirationDate value ("9/5/2027") — see
/// InputLotAndExpirationStep's own doc comment. Pure/no-UIA-dependency,
/// so unlike the rest of this step it CAN run here.
/// </summary>
public class InputLotAndExpirationStepDateFormatTests
{
    [Fact]
    public void ConvertsMacroFormatToPioneerDateEditFormat()
    {
        Assert.Equal("9/5/2027", InputLotAndExpirationStep.ToPioneerDateFormat("09052027"));
    }

    [Fact]
    public void DropsLeadingZerosFromBothMonthAndDay()
    {
        Assert.Equal("1/2/2030", InputLotAndExpirationStep.ToPioneerDateFormat("01022030"));
    }

    [Fact]
    public void HandlesDoubleDigitMonthAndDay()
    {
        Assert.Equal("12/31/2028", InputLotAndExpirationStep.ToPioneerDateFormat("12312028"));
    }

    [Fact]
    public void ReturnsNullForUnparsableInput()
    {
        Assert.Null(InputLotAndExpirationStep.ToPioneerDateFormat("not-a-date"));
        Assert.Null(InputLotAndExpirationStep.ToPioneerDateFormat(""));
        Assert.Null(InputLotAndExpirationStep.ToPioneerDateFormat("13012027")); // month 13 is invalid
    }
}
