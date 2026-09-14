using VaccineAssist.Desktop.Uia;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// DialogClassifier.Classify — PURE text classification for a pre-entry
/// dialog candidate, added for the 2026-09-14 popup-detection fix. Wraps
/// PreEntryDialogTitles.ContainsPriority/ContainsScanAndHardCopy plus a
/// "Cycle Fill" check into one DialogKind result — see
/// SendF3AndDismissPreEntryDialogsStep.TryDismissNextStrayPioneerWindow for
/// how this replaces the old three separate if-checks.
/// </summary>
public class DialogClassifierTests
{
    [Theory]
    [InlineData("Priority")]
    [InlineData("priority")]
    [InlineData("Select Priority")]
    [InlineData("Window title contains Priority somewhere")]
    public void ClassifiesPriorityText(string text)
    {
        Assert.Equal(DialogKind.Priority, DialogClassifier.Classify(text));
    }

    [Theory]
    [InlineData("Scan Hard Copy")]
    [InlineData("scan hard copy order")]
    [InlineData("Scan the Hard Copy prescription")]
    [InlineData("Hard Copy Scan")]
    public void ClassifiesScanHardCopyText(string text)
    {
        Assert.Equal(DialogKind.ScanHardCopy, DialogClassifier.Classify(text));
    }

    [Theory]
    [InlineData("Patient on Cycle Fill")]
    [InlineData("Cycle Fill Warning")]
    [InlineData("cycle fill")]
    public void ClassifiesPatientOnCycleFillText(string text)
    {
        Assert.Equal(DialogKind.PatientOnCycleFill, DialogClassifier.Classify(text));
    }

    [Theory]
    [InlineData("")]
    [InlineData("Add New Rx")]
    [InlineData("Rx Profile - Doe, Jane")]
    [InlineData("Scan only")] // missing "Hard Copy" — not enough for ScanHardCopy
    public void UnknownDialogIsReportedAsUnknown(string text)
    {
        Assert.Equal(DialogKind.Unknown, DialogClassifier.Classify(text));
    }

    [Fact]
    public void NullTextIsReportedAsUnknown()
    {
        Assert.Equal(DialogKind.Unknown, DialogClassifier.Classify(null!));
    }

    [Fact]
    public void PriorityIsCheckedBeforeScanHardCopyWhenBothAppear()
    {
        // Same precedence as TryDismissNextStrayPioneerWindow's own
        // ordering (Priority handled first, since it needs select+confirm
        // rather than a plain ESC).
        Assert.Equal(DialogKind.Priority, DialogClassifier.Classify("Priority Scan Hard Copy"));
    }
}
