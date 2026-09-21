using System;
using System.Collections.Generic;
using VaccineAssist.Desktop.Uia;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// ComboLBoxWindowLocator — V-T41 ROUND 4's pure "which enumerated
/// top-level window is the combo's own separate drop-down popup" filter
/// (brief point 3): a standard Win32 combo box's expanded list renders as
/// its OWN top-level window (class 'ComboLBox'), never a descendant of the
/// dialog/combo that owns it — see the class's own doc comment for the
/// full root-cause explanation tying this back to Will's 2026-09-21 log.
/// </summary>
public class ComboLBoxWindowLocatorTests
{
    private const int MainProcessId = 42;

    private static WindowInfo Window(IntPtr handle, int processId, string className) =>
        new(handle, "", processId, IntPtr.Zero, false, false, ClassName: className);

    [Fact]
    public void FindsASameProcessComboLBoxWindow()
    {
        var combo = Window(new IntPtr(1), MainProcessId, "ComboLBox");
        var windows = new[] { combo };

        var found = ComboLBoxWindowLocator.Find(windows, MainProcessId);

        Assert.Equal(combo, found);
    }

    [Fact]
    public void IsCaseInsensitiveOnTheClassName()
    {
        var combo = Window(new IntPtr(1), MainProcessId, "combolbox");

        Assert.NotNull(ComboLBoxWindowLocator.Find(new[] { combo }, MainProcessId));
    }

    [Fact]
    public void IgnoresAComboLBoxWindowFromADifferentProcess()
    {
        var otherProcessCombo = Window(new IntPtr(1), 99, "ComboLBox");

        Assert.Null(ComboLBoxWindowLocator.Find(new[] { otherProcessCombo }, MainProcessId));
    }

    [Fact]
    public void IgnoresNonComboLBoxWindowClasses()
    {
        var windows = new[]
        {
            Window(new IntPtr(1), MainProcessId, "Auto-Suggest Dropdown"),
            Window(new IntPtr(2), MainProcessId, "tooltips_class32"),
            Window(new IntPtr(3), MainProcessId, "WindowsForms10.Window.8.app.0.37e3228_r7_ad1"),
        };

        Assert.Null(ComboLBoxWindowLocator.Find(windows, MainProcessId));
    }

    [Fact]
    public void ReturnsNullWhenNoWindowsAreGiven()
    {
        Assert.Null(ComboLBoxWindowLocator.Find(Array.Empty<WindowInfo>(), MainProcessId));
    }

    [Fact]
    public void ReturnsTheFirstMatchWhenMultipleComboLBoxWindowsExist()
    {
        var first = Window(new IntPtr(1), MainProcessId, "ComboLBox");
        var second = Window(new IntPtr(2), MainProcessId, "ComboLBox");

        var found = ComboLBoxWindowLocator.Find(new[] { first, second }, MainProcessId);

        Assert.Equal(first, found);
    }

    [Fact]
    public void FindsTheComboLBoxAmongOtherUnrelatedWindows()
    {
        var mainWindow = Window(new IntPtr(1), MainProcessId, "WindowsForms10.Window.8.app.0.37e3228_r7_ad1");
        var priorityDialog = new WindowInfo(new IntPtr(2), "Priority", MainProcessId, IntPtr.Zero, false, true);
        var combo = Window(new IntPtr(3), MainProcessId, "ComboLBox");
        var windows = new List<WindowInfo> { mainWindow, priorityDialog, combo };

        Assert.Equal(combo, ComboLBoxWindowLocator.Find(windows, MainProcessId));
    }
}
