using System;
using System.Runtime.InteropServices;
using VaccineAssist.Desktop.PioneerEntryAutomation.Native;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-T41 ROUND 5: NativeKeyboard's SendInput call passes
/// <c>Marshal.SizeOf&lt;NativeInput&gt;()</c> as <c>cbSize</c> — if that
/// doesn't match Win32's real <c>sizeof(INPUT)</c>, SendInput silently
/// rejects every event it's given (per MSDN: "If cbSize is not the size
/// of an INPUT structure, the function fails"), which would look
/// EXACTLY like the live symptom this whole round exists to fix (F12
/// "does nothing"). This is a plain struct-layout check — no live
/// Windows API call, no P/Invoke execution — so it runs anywhere the CLR
/// does, including a non-Windows dev machine (Marshal.SizeOf computes
/// managed struct layout, it doesn't call into user32.dll).
/// </summary>
public class NativeInputStructSizeTests
{
    [Fact]
    public void InputStructSizeMatchesWin32Definition()
    {
        var expected = IntPtr.Size == 8 ? 40 : 28;
        Assert.Equal(expected, Marshal.SizeOf<NativeInput>());
    }
}
