using System;
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

    // --- V-T41: Auto-Suggest Dropdown timeout fix — IsTransientWindowClass / IsTransientWindow ---

    [Theory]
    [InlineData("Auto-Suggest Dropdown")]
    [InlineData("auto-suggest dropdown")] // case-insensitive
    [InlineData("tooltips_class32")]
    [InlineData("Xaml_WindowedPopupClass")]
    [InlineData("DropDown")]
    [InlineData("ComboLBox")]
    [InlineData("SomeVendorTooltipWindow")] // "Tooltip" fragment
    [InlineData("MyAutoSuggestPopup")] // "AutoSuggest"/"Popup" fragments
    public void IsTransientWindowClassRecognizesKnownPopupClasses(string windowClass)
    {
        Assert.True(DialogClassifier.IsTransientWindowClass(windowClass));
    }

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("#32770")] // a real Win32 dialog class
    [InlineData("Button")]
    public void IsTransientWindowClassRejectsNonTransientClasses(string? windowClass)
    {
        Assert.False(DialogClassifier.IsTransientWindowClass(windowClass));
    }

    [Fact]
    public void IsTransientWindowIsTrueForAutoSuggestDropdown()
    {
        // The exact shape from Will's 18:53 app.log: a Pioneer-owned
        // top-level window with an empty title and class 'Auto-Suggest
        // Dropdown' that the old code ESC'd every ~7s until the step timed
        // out.
        var window = new WindowInfo(new IntPtr(1), "", 1234, IntPtr.Zero, IsPopupStyle: true, IsDialogFrameStyle: false, ClassName: "Auto-Suggest Dropdown");
        Assert.True(DialogClassifier.IsTransientWindow(window));
    }

    [Fact]
    public void IsTransientWindowIsTrueForATooltipClass()
    {
        var window = new WindowInfo(new IntPtr(2), "", 1234, IntPtr.Zero, IsPopupStyle: true, IsDialogFrameStyle: false, ClassName: "tooltips_class32");
        Assert.True(DialogClassifier.IsTransientWindow(window));
    }

    [Fact]
    public void IsTransientWindowIsTrueForAnUntitledNonDialogFrameWindowEvenWithAnUnknownClass()
    {
        // No recognized class name, but empty title + not a real dialog
        // frame is still the shape of a transient window this repo hasn't
        // named yet — see IsTransientWindow's doc comment.
        var window = new WindowInfo(new IntPtr(3), "", 1234, IntPtr.Zero, IsPopupStyle: true, IsDialogFrameStyle: false, ClassName: "SomeUnknownClass");
        Assert.True(DialogClassifier.IsTransientWindow(window));
    }

    [Fact]
    public void IsTransientWindowIsFalseForARealDialogWithATitle()
    {
        var window = new WindowInfo(new IntPtr(4), "Priority", 1234, IntPtr.Zero, IsPopupStyle: true, IsDialogFrameStyle: true, ClassName: "#32770");
        Assert.False(DialogClassifier.IsTransientWindow(window));
    }

    [Fact]
    public void IsTransientWindowIsFalseForAnUntitledRealDialogFrame()
    {
        // Empty title alone isn't enough — a genuine WS_DLGFRAME window
        // (even if its title happens to be blank) is not treated as
        // transient just because a recognized popup class didn't match.
        var window = new WindowInfo(new IntPtr(5), "", 1234, IntPtr.Zero, IsPopupStyle: true, IsDialogFrameStyle: true, ClassName: "#32770");
        Assert.False(DialogClassifier.IsTransientWindow(window));
    }
}
