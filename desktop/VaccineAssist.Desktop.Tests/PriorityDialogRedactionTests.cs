using VaccineAssist.Desktop.Uia;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-T41 ROUND 4 REVIEW FIX (BLOCKER — safety reviewer, PHI): the old
/// heuristic ("log any element Name ≤ 20 chars with no digits") let a real
/// patient name like "Smith, Jane" through verbatim. PriorityDialogRedaction
/// replaces it with an allow-list: a name is only ever logged verbatim when
/// it EXACTLY matches (case-insensitive, trimmed) a known non-patient UI
/// word; everything else — including a plausible short, digit-free,
/// patient-name-shaped string — logs as length only.
/// </summary>
public class PriorityDialogRedactionTests
{
    [Theory]
    [InlineData("Priority")]
    [InlineData("vaccine")] // case-insensitive
    [InlineData("OK")]
    [InlineData("Cancel")]
    [InlineData("  Save  ")] // trimmed
    [InlineData("Button")]
    [InlineData("ComboBox")]
    public void AllowListedWordIsLoggedVerbatim(string name)
    {
        var result = PriorityDialogRedaction.Redact(name);
        Assert.Equal($"name='{name.Trim()}'", result);
    }

    [Fact]
    public void PatientNameShapedStringIsNeverEmittedVerbatim()
    {
        // "Smith, Jane" is exactly the shape the old heuristic (<=20 chars,
        // no digits) would have passed through unredacted. It must never
        // appear in the output at all — only a length.
        const string patientName = "Smith, Jane";
        var result = PriorityDialogRedaction.Redact(patientName);

        Assert.DoesNotContain(patientName, result);
        Assert.DoesNotContain("Smith", result);
        Assert.DoesNotContain("Jane", result);
        Assert.Equal($"len={patientName.Length}", result);
    }

    [Theory]
    [InlineData("John Doe")]
    [InlineData("Mary")]
    [InlineData("Patient X")]
    [InlineData("Anderson")]
    public void OtherShortDigitFreeNamesAlsoLogAsLengthOnly(string name)
    {
        var result = PriorityDialogRedaction.Redact(name);
        Assert.Equal($"len={name.Length}", result);
        Assert.DoesNotContain(name, result);
    }

    [Fact]
    public void NullOrEmptyNameLogsAsEmpty()
    {
        Assert.Equal("name=''", PriorityDialogRedaction.Redact(null));
        Assert.Equal("name=''", PriorityDialogRedaction.Redact(""));
    }
}
