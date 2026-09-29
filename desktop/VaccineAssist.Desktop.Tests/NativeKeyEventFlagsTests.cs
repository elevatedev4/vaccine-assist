using System;
using VaccineAssist.Desktop.PioneerEntryAutomation.Native;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-T41 ROUND 6 (reviewer REQUEST_CHANGES on round 5, ported from
/// rx-verify's own Reports/NativeInputTests.cs coverage shape):
/// NativeKeyEventFlags.IsExtendedKey and NativeKeyboardTiming's delay
/// constants are both pure (no P/Invoke), so they run anywhere the CLR
/// does, same as NativeInputStructSizeTests.
/// </summary>
public class NativeKeyEventFlagsTests
{
    private const ushort VK_DOWN = 0x28;
    private const ushort VK_LEFT = 0x25;
    private const ushort VK_HOME = 0x24;
    private const ushort VK_F12 = 0x7B;
    private const ushort VK_A = 0x41;
    private const ushort VK_RETURN = 0x0D;

    [Theory]
    [InlineData(VK_DOWN)]
    [InlineData(VK_LEFT)]
    [InlineData(VK_HOME)]
    public void IsExtendedKeyIsTrueForArrowAndNavigationKeys(ushort vk)
    {
        // Round 5's actual bug: the Priority dialog's Alt+Down fallback
        // sends VK_DOWN without this flag — whether it opens the combo or
        // types NumPad '2' then silently depends on the target's NumLock
        // state instead of on wVk.
        Assert.True(NativeKeyEventFlags.IsExtendedKey(vk));
    }

    [Theory]
    [InlineData(VK_F12)]
    [InlineData(VK_A)]
    [InlineData(VK_RETURN)]
    public void IsExtendedKeyIsFalseForNonExtendedKeys(ushort vk)
    {
        Assert.False(NativeKeyEventFlags.IsExtendedKey(vk));
    }

    /// <summary>
    /// Reviewer's explicit ask: the per-key/per-character delay must be at
    /// least as generous as rx-verify's own KeystrokeCharDelay (30ms) —
    /// the value Macro Express's default "simulate keystrokes" per-key
    /// delay is modeled on, and the value that's already known to make
    /// legacy WinForms input handling behave correctly in this exact
    /// class of app.
    /// </summary>
    [Fact]
    public void KeystrokeCharDelayIsAtLeastRxVerifysValue()
    {
        var rxVerifyValue = TimeSpan.FromMilliseconds(30);
        Assert.True(
            NativeKeyboardTiming.KeystrokeCharDelay >= rxVerifyValue,
            $"NativeKeyboardTiming.KeystrokeCharDelay ({NativeKeyboardTiming.KeystrokeCharDelay}) must be >= rx-verify's KeystrokeCharDelay ({rxVerifyValue}).");
    }
}
