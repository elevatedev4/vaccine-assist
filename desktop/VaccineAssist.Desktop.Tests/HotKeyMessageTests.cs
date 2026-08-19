using System;
using VaccineAssist.Desktop.Hotkeys;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class HotKeyMessageTests
{
    [Fact]
    public void ParsesHotKeyIdFromWmHotkeyMessage()
    {
        var wParam = new IntPtr(1);

        var parsed = HotKeyMessage.TryParseHotKeyId(HotKeyMessage.WM_HOTKEY, wParam, out var id);

        Assert.True(parsed);
        Assert.Equal(1, id);
    }

    [Fact]
    public void OnlyUsesTheLowWordOfWParam()
    {
        // Win32 packs modifiers/extra data into the high word for some
        // messages; WM_HOTKEY's contract is "id is the low word", so a
        // nonzero high word must not corrupt the parsed id.
        var wParam = new IntPtr(unchecked((int)0x00AB0007));

        var parsed = HotKeyMessage.TryParseHotKeyId(HotKeyMessage.WM_HOTKEY, wParam, out var id);

        Assert.True(parsed);
        Assert.Equal(7, id);
    }

    [Fact]
    public void ReturnsFalseForAnyOtherMessage()
    {
        var parsed = HotKeyMessage.TryParseHotKeyId(0x000F /* WM_PAINT */, new IntPtr(1), out var id);

        Assert.False(parsed);
        Assert.Equal(0, id);
    }
}
