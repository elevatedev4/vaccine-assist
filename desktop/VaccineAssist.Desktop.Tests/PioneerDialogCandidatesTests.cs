using System;
using System.Collections.Generic;
using System.Linq;
using VaccineAssist.Desktop.Uia;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// PioneerDialogCandidates.Select — the PURE (no UIA/FlaUI/Win32
/// dependency) "which top-level windows are real dialog candidates for the
/// attached PioneerRx main window" filter added for the 2026-09-14
/// popup-detection fix (Will, verbatim): "The app is not recognizing the
/// Pioneer windows that pop up and is instead trying to stay focused and
/// work in the Pioneer main window." See SendF3AndDismissPreEntryDialogsStep's
/// FindPioneerDialogCandidates for how this is wired up against a live
/// combined UIA+Win32 enumeration (PioneerWindowInventory.EnumerateAllWindows).
/// </summary>
public class PioneerDialogCandidatesTests
{
    private static readonly IntPtr MainHwnd = new(1000);
    private const int MainProcessId = 42;

    [Fact]
    public void OwnedTopLevelPopupIsSelected()
    {
        var popup = new WindowInfo(new IntPtr(1001), "Priority", MainProcessId, MainHwnd, IsPopupStyle: true, IsDialogFrameStyle: false);

        var result = PioneerDialogCandidates.Select(new[] { popup }, MainProcessId, MainHwnd);

        Assert.Single(result);
        Assert.Equal(popup, result[0]);
    }

    [Fact]
    public void WindowsFromOtherProcessesAreIgnored()
    {
        var otherProcessWindow = new WindowInfo(new IntPtr(2001), "Priority", 99, IntPtr.Zero, false, false);

        var result = PioneerDialogCandidates.Select(new[] { otherProcessWindow }, MainProcessId, MainHwnd);

        Assert.Empty(result);
    }

    [Fact]
    public void MainWindowItselfIsExcluded()
    {
        var mainWindow = new WindowInfo(MainHwnd, "Rx Profile - Doe, Jane", MainProcessId, IntPtr.Zero, false, false);

        var result = PioneerDialogCandidates.Select(new[] { mainWindow }, MainProcessId, MainHwnd);

        Assert.Empty(result);
    }

    [Fact]
    public void ZeroHandleWindowsAreExcluded()
    {
        var zeroHandle = new WindowInfo(IntPtr.Zero, "Priority", MainProcessId, MainHwnd, true, false);

        var result = PioneerDialogCandidates.Select(new[] { zeroHandle }, MainProcessId, MainHwnd);

        Assert.Empty(result);
    }

    [Fact]
    public void DuplicateHandlesFromMultipleSourcesAreDeduped()
    {
        var handle = new IntPtr(3001);
        var fromUia = new WindowInfo(handle, "Priority", MainProcessId, IntPtr.Zero, false, false);
        var fromWin32 = new WindowInfo(handle, "Priority", MainProcessId, MainHwnd, true, false);

        var result = PioneerDialogCandidates.Select(new[] { fromUia, fromWin32 }, MainProcessId, MainHwnd);

        Assert.Single(result);
    }

    [Fact]
    public void MultipleGenuineCandidatesAreAllSelected()
    {
        var priority = new WindowInfo(new IntPtr(4001), "Priority", MainProcessId, MainHwnd, true, false);
        var cycleFill = new WindowInfo(new IntPtr(4002), "Cycle Fill Warning", MainProcessId, IntPtr.Zero, false, true);

        var result = PioneerDialogCandidates.Select(new[] { priority, cycleFill }, MainProcessId, MainHwnd);

        Assert.Equal(2, result.Count);
        Assert.Contains(result, w => w.Handle == priority.Handle);
        Assert.Contains(result, w => w.Handle == cycleFill.Handle);
    }

    [Fact]
    public void EmptyInputReturnsEmptyResult()
    {
        var result = PioneerDialogCandidates.Select(Array.Empty<WindowInfo>(), MainProcessId, MainHwnd);

        Assert.Empty(result);
    }

    [Fact]
    public void UnownedSameProcessWindowIsStillSelected()
    {
        // Pioneer's Priority/Cycle Fill/Scan Hard Copy dialogs are
        // unconfirmed against a live UIA dump and may not set an explicit
        // Win32 owner — Select() deliberately does NOT require
        // OwnerHandle == mainHwnd (see its own doc comment), only same
        // process + not the main window, so a same-process window with no
        // owner set at all is still a candidate.
        var unowned = new WindowInfo(new IntPtr(5001), "Scan Hard Copy", MainProcessId, IntPtr.Zero, false, false);

        var result = PioneerDialogCandidates.Select(new[] { unowned }, MainProcessId, MainHwnd);

        Assert.Single(result);
    }
}
