using VaccineAssist.Desktop.Hotkeys;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// GlobalHotKey itself needs a real WPF Window with a native handle to
/// register/unregister against (Win32 RegisterHotKey), so — same as
/// before this class existed — it isn't covered by a fast xUnit test here.
/// This only pins down the plain constant values 2026-09-13 added
/// (VK_8, for the macro-codes popup's Ctrl+8 hotkey) so a future edit
/// can't silently change either virtual-key code without a test noticing.
/// </summary>
public class GlobalHotKeyConstantsTests
{
    [Fact]
    public void Vk8IsTheTopRowNumberEightVirtualKeyCode()
    {
        Assert.Equal(0x38u, GlobalHotKey.VK_8);
    }

    [Fact]
    public void VkNumPad7IsUnchangedByTheVkParameterization()
    {
        Assert.Equal(0x67u, GlobalHotKey.VK_NUMPAD7);
    }

    [Fact]
    public void MacroCodesHotkeyUsesADifferentVirtualKeyThanDataEntryHotkey()
    {
        // The two GlobalHotKey instances MainWindow registers (data-entry
        // Ctrl+NumPad7, macro-codes Ctrl+8) must use different vk values —
        // same vk with different ids would still be two distinct
        // RegisterHotKey calls for the SAME key combination, and Win32
        // would fail the second one as already-claimed.
        Assert.NotEqual(GlobalHotKey.VK_NUMPAD7, GlobalHotKey.VK_8);
    }
}
