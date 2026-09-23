using System;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class RowFingerprintTests
{
    [Fact]
    public void SameInputProducesSameFingerprint()
    {
        var a = RowFingerprint.Compute("Test", "Patient", new DateOnly(1990, 1, 1), "Flu", "LOT1", new DateOnly(2026, 9, 1));
        var b = RowFingerprint.Compute("Test", "Patient", new DateOnly(1990, 1, 1), "Flu", "LOT1", new DateOnly(2026, 9, 1));

        Assert.Equal(a, b);
    }

    [Fact]
    public void CasingAndWhitespaceDoNotChangeFingerprint()
    {
        var a = RowFingerprint.Compute("Test", "Patient", null, "Flu", "LOT1", new DateOnly(2026, 9, 1));
        var b = RowFingerprint.Compute("  test ", " patient ", null, " FLU ", " lot1 ", new DateOnly(2026, 9, 1));

        Assert.Equal(a, b);
    }

    [Fact]
    public void DifferentLotProducesDifferentFingerprint()
    {
        var a = RowFingerprint.Compute("Test", "Patient", null, "Flu", "LOT1", new DateOnly(2026, 9, 1));
        var b = RowFingerprint.Compute("Test", "Patient", null, "Flu", "LOT2", new DateOnly(2026, 9, 1));

        Assert.NotEqual(a, b);
    }

    [Fact]
    public void DifferentAdministeredDateProducesDifferentFingerprint()
    {
        var a = RowFingerprint.Compute("Test", "Patient", null, "Flu", "LOT1", new DateOnly(2026, 9, 1));
        var b = RowFingerprint.Compute("Test", "Patient", null, "Flu", "LOT1", new DateOnly(2026, 9, 2));

        Assert.NotEqual(a, b);
    }
}
