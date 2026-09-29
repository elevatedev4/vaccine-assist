using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Native;

/// <summary>
/// V-T41 ROUND 5 (Will's 2026-09-29 follow-up, verbatim: "I have given
/// you the exact keystrokes that are needed in the original macro file
/// and explained the problem in full detail and you still haven't gotten
/// it ... Fix it."): raw <c>SendInput</c> keyboard helper for the
/// Priority dialog's Save (F12) send and everything that shares its
/// code path (the typed value, Enter, Alt+O fallbacks) — every
/// KEYBDINPUT carries BOTH a virtual-key code AND its real hardware scan
/// code (<c>MapVirtualKeyW(vk, MAPVK_VK_TO_VSC)</c>), the same shape a
/// physical keyboard — or Macro Express, the tool Will's original macro
/// was built in — produces. FlaUI's <c>Keyboard.Type</c> (used by every
/// prior round of this fix) calls SendInput too, but leaves
/// <c>wScan</c> at 0; some legacy WinForms hotkey handling (which is
/// exactly what Pioneer's Priority dialog's Save shortcut needs to look
/// like a real key — the live symptom is F12 doing nothing at all, not
/// an exception) filters or ignores a zero-scan-code key event. This
/// class is the fix for THAT specific gap; it is a thin, uncached Win32
/// wrapper only — the struct shape it marshals is NativeInput.cs's own
/// pure, directly-testable half (see that file's doc comment for why the
/// split), and the decision of WHEN it's safe to call this (foreground
/// checks, dropdown state) stays in SendF3AndDismissPreEntryDialogsStep/
/// PriorityInputGuard, unchanged by this class. Every method here is
/// best-effort/never-throws (same posture as every other native wrapper
/// in this codebase — see Win32WindowEnumerator's own doc) and returns
/// whether SendInput actually reported sending every event, so the
/// caller's log line is conclusive rather than "an action was
/// attempted."
/// </summary>
public static class NativeKeyboard
{
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint MAPVK_VK_TO_VSC = 0;
    private const ushort VK_SHIFT = 0x10;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, NativeInput[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern short VkKeyScanW(char ch);

    [DllImport("user32.dll")]
    private static extern uint MapVirtualKeyW(uint uCode, uint uMapType);

    /// <summary>Sends one virtual-key press+release (e.g. VK_F12 = 0x7B,
    /// VK_RETURN = 0x0D) as raw SendInput events, scan code included.
    /// Returns true only when SendInput reports both events sent — see
    /// class doc comment. `what` is a short label for the log line only
    /// (e.g. "F12 (Save)").</summary>
    public static bool SendKey(ushort virtualKey, Action<string>? log = null, string what = "")
    {
        try
        {
            var scan = (ushort)MapVirtualKeyW(virtualKey, MAPVK_VK_TO_VSC);
            var events = new[]
            {
                MakeKeyEvent(virtualKey, scan, keyUp: false),
                MakeKeyEvent(virtualKey, scan, keyUp: true),
            };
            return Send(events, log, $"SendKey vk=0x{virtualKey:X2} scan=0x{scan:X2} what=\"{what}\"");
        }
        catch (Exception ex)
        {
            log?.Invoke($"NativeKeyboard.SendKey vk=0x{virtualKey:X2} what=\"{what}\" -> threw {ex.GetType().Name}: {ex.Message}.");
            return false;
        }
    }

    /// <summary>Sends Alt+&lt;virtualKey&gt; as raw SendInput events (e.g.
    /// Alt+O — VK_MENU down, key down, key up, VK_MENU up), scan codes
    /// included on every one.</summary>
    public static bool SendAltChord(ushort virtualKey, Action<string>? log = null, string what = "")
    {
        try
        {
            const ushort VK_MENU = 0x12;
            var altScan = (ushort)MapVirtualKeyW(VK_MENU, MAPVK_VK_TO_VSC);
            var scan = (ushort)MapVirtualKeyW(virtualKey, MAPVK_VK_TO_VSC);
            var events = new[]
            {
                MakeKeyEvent(VK_MENU, altScan, keyUp: false),
                MakeKeyEvent(virtualKey, scan, keyUp: false),
                MakeKeyEvent(virtualKey, scan, keyUp: true),
                MakeKeyEvent(VK_MENU, altScan, keyUp: true),
            };
            return Send(events, log, $"SendAltChord vk=0x{virtualKey:X2} scan=0x{scan:X2} what=\"{what}\"");
        }
        catch (Exception ex)
        {
            log?.Invoke($"NativeKeyboard.SendAltChord vk=0x{virtualKey:X2} what=\"{what}\" -> threw {ex.GetType().Name}: {ex.Message}.");
            return false;
        }
    }

    /// <summary>Sends one printable character via <c>VkKeyScanW</c>
    /// (virtual-key + required shift state), scan code included — used
    /// for the Priority combo's type-ahead ("V" / "Vaccine") so that path
    /// gets the same real-scan-code treatment as the F12 Save send.
    /// Returns false (no events sent) when VkKeyScanW can't map the
    /// character at all.</summary>
    public static bool SendChar(char ch, Action<string>? log = null)
    {
        try
        {
            var vkScan = VkKeyScanW(ch);
            if (vkScan == -1)
            {
                log?.Invoke($"NativeKeyboard.SendChar '{ch}' -> VkKeyScanW found no mapping.");
                return false;
            }

            var vk = (ushort)(vkScan & 0xFF);
            var shiftState = (vkScan >> 8) & 0xFF;
            var needsShift = (shiftState & 1) != 0;
            var scan = (ushort)MapVirtualKeyW(vk, MAPVK_VK_TO_VSC);
            var shiftScan = (ushort)MapVirtualKeyW(VK_SHIFT, MAPVK_VK_TO_VSC);

            var events = new List<NativeInput>(4);
            if (needsShift) events.Add(MakeKeyEvent(VK_SHIFT, shiftScan, keyUp: false));
            events.Add(MakeKeyEvent(vk, scan, keyUp: false));
            events.Add(MakeKeyEvent(vk, scan, keyUp: true));
            if (needsShift) events.Add(MakeKeyEvent(VK_SHIFT, shiftScan, keyUp: true));

            return Send(events.ToArray(), log, $"SendChar '{ch}' vk=0x{vk:X2} scan=0x{scan:X2} shift={needsShift}");
        }
        catch (Exception ex)
        {
            log?.Invoke($"NativeKeyboard.SendChar '{ch}' -> threw {ex.GetType().Name}: {ex.Message}.");
            return false;
        }
    }

    /// <summary>Sends every character in `text` via SendChar, in order.
    /// Returns true only when every character was sent.</summary>
    public static bool SendText(string text, Action<string>? log = null)
    {
        var ok = true;
        foreach (var ch in text)
        {
            ok = SendChar(ch, log) && ok;
        }
        return ok;
    }

    private static bool Send(NativeInput[] events, Action<string>? log, string what)
    {
        var sent = SendInput((uint)events.Length, events, Marshal.SizeOf<NativeInput>());
        var ok = sent == events.Length;
        log?.Invoke($"NativeKeyboard.{what} -> SendInput returned {sent} (expected {events.Length}, ok={ok}).");
        return ok;
    }

    private static NativeInput MakeKeyEvent(ushort virtualKey, ushort scan, bool keyUp) => new()
    {
        type = NativeInputType.Keyboard,
        u = new InputUnion
        {
            ki = new KEYBDINPUT
            {
                wVk = virtualKey,
                wScan = scan,
                dwFlags = keyUp ? KEYEVENTF_KEYUP : 0,
                time = 0,
                dwExtraInfo = 0,
            },
        },
    };
}
