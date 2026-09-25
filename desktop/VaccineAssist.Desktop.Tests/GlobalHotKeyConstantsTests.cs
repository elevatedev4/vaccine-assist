using VaccineAssist.Desktop.Hotkeys;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// GlobalHotKey itself needs a real WPF Window with a native handle to
/// register/unregister against (Win32 RegisterHotKey), so — same as
/// before this class existed — it isn't covered by a fast xUnit test here.
/// This only pins down the plain constant values 2026-09-13 added
/// (VK_NUMPAD8, for the macro-codes popup's Ctrl+Keypad 8 hotkey — moved
/// off VK_8/Ctrl+8 per Will's follow-up brief) so a future edit can't
/// silently change either virtual-key code without a test noticing.
/// </summary>
public class GlobalHotKeyConstantsTests
{
    [Fact]
    public void VkNumPad8IsTheNumpadEightVirtualKeyCode()
    {
        Assert.Equal(0x68u, GlobalHotKey.VK_NUMPAD8);
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
        // Ctrl+NumPad7, macro-codes Ctrl+Keypad 8) must use different vk
        // values — same vk with different ids would still be two distinct
        // RegisterHotKey calls for the SAME key combination, and Win32
        // would fail the second one as already-claimed.
        Assert.NotEqual(GlobalHotKey.VK_NUMPAD7, GlobalHotKey.VK_NUMPAD8);
    }

    /// <summary>2026-09-25: pins VK_NUMPAD4 (the Ctrl+Keypad 4 age-macro
    /// hotkey's virtual key — see MainWindow's _ageMacroHotKey) so a
    /// future edit can't silently change it without a test noticing, same
    /// as the VK_NUMPAD8 test above.</summary>
    [Fact]
    public void VkNumPad4IsTheNumpadFourVirtualKeyCode()
    {
        Assert.Equal(0x64u, GlobalHotKey.VK_NUMPAD4);
    }

    /// <summary>All three GlobalHotKey instances MainWindow registers
    /// (data-entry Ctrl+NumPad7, macro-codes Ctrl+Keypad 8, age-macro
    /// Ctrl+Keypad 4) must use pairwise-distinct vk values — same
    /// reasoning as MacroCodesHotkeyUsesADifferentVirtualKeyThanDataEntryHotkey
    /// above, extended to the third hotkey.</summary>
    [Fact]
    public void AgeMacroHotkeyUsesADifferentVirtualKeyThanTheOtherTwoHotkeys()
    {
        Assert.NotEqual(GlobalHotKey.VK_NUMPAD4, GlobalHotKey.VK_NUMPAD7);
        Assert.NotEqual(GlobalHotKey.VK_NUMPAD4, GlobalHotKey.VK_NUMPAD8);
    }
}
