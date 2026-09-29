using System;
using System.Runtime.InteropServices;
using System.Threading;

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
///
/// V-T41 ROUND 6 (reviewer REQUEST_CHANGES on round 5, mirroring
/// rx-verify's Reports/NativeInput.cs — TypeKeystrokes/SendSpecialKey/
/// IsExtendedKey): two gaps in round 5's implementation fixed here —
/// (1) EVERY event now goes through SendOneKeyEvent, which ORs
/// NativeKeyEventFlags.KEYEVENTF_EXTENDEDKEY into dwFlags for any
/// virtual-key NativeKeyEventFlags.IsExtendedKey flags (round 5's
/// SendAltChord sent VK_DOWN, 0x28, for the Alt+Down fallback with no
/// such flag — whether that opens the combo or types NumPad '2' would
/// have silently depended on the target's NumLock state); (2) every send
/// path now sleeps NativeKeyboardTiming.KeystrokeCharDelay — once between
/// SendKey's own down/up pair, and once per character in SendChar (so
/// SendText, which just calls SendChar in a loop, inherits it too) —
/// since legacy WinForms input handling (exactly what Pioneer's Priority
/// dialog is) can drop or mis-sequence back-to-back synthetic input with
/// no settle time between events.
///
/// V-T41 ROUND 6 DELTA FIX (reviewer REQUEST_CHANGES, minor): SendChar's
/// Shift-up and SendAltChord's Alt-up now run in a `finally` block, not as
/// a plain sequential statement — a thrown exception (not just a `false`
/// result) between the down send and the release send used to skip the
/// release entirely, leaving Shift/Alt physically "held" for every
/// keystroke sent afterward. Mirrors rx-verify's own TypeKeystrokes
/// try/finally exactly.
/// </summary>
public static class NativeKeyboard
{
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint MAPVK_VK_TO_VSC = 0;
    private const ushort VK_SHIFT = 0x10;
    private const ushort VK_MENU = 0x12;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, NativeInput[] pInputs, int cbSize);

    /// <summary>V-T41 ROUND 6 (reviewer MAJOR finding 3): explicit
    /// CharSet.Unicode (matching rx-verify's own declaration) — the
    /// default DllImport CharSet is ANSI, and while plain ASCII
    /// digits/letters marshal identically either way, this keeps the
    /// P/Invoke shape correct for any non-ASCII character a Priority
    /// value could someday contain. SetLastError so a mapping failure is
    /// diagnosable via Marshal.GetLastWin32Error, same as SendInput's own
    /// declaration already was.</summary>
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern short VkKeyScanW(char ch);

    /// <summary>See VkKeyScanW's doc comment for why CharSet.Unicode +
    /// SetLastError were added here too.</summary>
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint MapVirtualKeyW(uint uCode, uint uMapType);

    /// <summary>Sends one virtual-key press+release (e.g. VK_F12 = 0x7B,
    /// VK_RETURN = 0x0D) as raw SendInput events, scan code AND (when
    /// applicable) KEYEVENTF_EXTENDEDKEY included, with
    /// NativeKeyboardTiming.KeystrokeCharDelay between the down and up
    /// events (V-T41 ROUND 6 — see class doc comment). Returns true only
    /// when SendInput reports both events sent. `what` is a short label
    /// for the log line only (e.g. "F12 (Save)").</summary>
    public static bool SendKey(ushort virtualKey, Action<string>? log = null, string what = "")
    {
        try
        {
            var scan = (ushort)MapVirtualKeyW(virtualKey, MAPVK_VK_TO_VSC);

            var downOk = SendOneKeyEvent(virtualKey, scan, keyUp: false, log, $"SendKey vk=0x{virtualKey:X2} scan=0x{scan:X2} what=\"{what}\" (down)");
            Thread.Sleep(NativeKeyboardTiming.KeystrokeCharDelay);
            var upOk = SendOneKeyEvent(virtualKey, scan, keyUp: true, log, $"SendKey vk=0x{virtualKey:X2} scan=0x{scan:X2} what=\"{what}\" (up)");

            return downOk && upOk;
        }
        catch (Exception ex)
        {
            log?.Invoke($"NativeKeyboard.SendKey vk=0x{virtualKey:X2} what=\"{what}\" -> threw {ex.GetType().Name}: {ex.Message}.");
            return false;
        }
    }

    /// <summary>Sends Alt+&lt;virtualKey&gt; as raw SendInput events (e.g.
    /// Alt+O — VK_MENU down, key down, key up, VK_MENU up), scan codes
    /// AND (when applicable) KEYEVENTF_EXTENDEDKEY included on every one
    /// (V-T41 ROUND 6 — this is what fixes the Alt+Down fallback: VK_DOWN
    /// now correctly carries the flag instead of silently depending on
    /// NumLock state), each event separated by
    /// NativeKeyboardTiming.KeystrokeCharDelay. V-T41 ROUND 6 DELTA FIX
    /// (reviewer): Alt-up runs in a `finally` — same reasoning as
    /// SendChar's Shift-up fix — so a thrown exception between Alt-down and
    /// the key send can never leave Alt physically "held" for every
    /// keystroke sent afterward.</summary>
    public static bool SendAltChord(ushort virtualKey, Action<string>? log = null, string what = "")
    {
        try
        {
            var altScan = (ushort)MapVirtualKeyW(VK_MENU, MAPVK_VK_TO_VSC);
            var scan = (ushort)MapVirtualKeyW(virtualKey, MAPVK_VK_TO_VSC);
            var label = $"SendAltChord vk=0x{virtualKey:X2} scan=0x{scan:X2} what=\"{what}\"";

            var altIsDown = false;
            var altDownOk = true;
            var keyDownOk = false;
            var keyUpOk = false;
            var altUpOk = true;
            try
            {
                altDownOk = SendOneKeyEvent(VK_MENU, altScan, keyUp: false, log, $"{label} (Alt down)");
                altIsDown = altDownOk;
                Thread.Sleep(NativeKeyboardTiming.KeystrokeCharDelay);

                keyDownOk = SendOneKeyEvent(virtualKey, scan, keyUp: false, log, $"{label} (key down)");
                Thread.Sleep(NativeKeyboardTiming.KeystrokeCharDelay);
                keyUpOk = SendOneKeyEvent(virtualKey, scan, keyUp: true, log, $"{label} (key up)");
                Thread.Sleep(NativeKeyboardTiming.KeystrokeCharDelay);
            }
            finally
            {
                if (altIsDown)
                {
                    altUpOk = SendOneKeyEvent(VK_MENU, altScan, keyUp: true, log, $"{label} (Alt up)");
                }
            }

            return altDownOk && keyDownOk && keyUpOk && altUpOk;
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
    /// gets the same real-scan-code treatment as the F12 Save send. Sleeps
    /// NativeKeyboardTiming.KeystrokeCharDelay once after the character is
    /// fully sent (V-T41 ROUND 6) — same granularity as rx-verify's own
    /// TypeKeystrokes. Returns false (no events sent) when VkKeyScanW
    /// can't map the character at all. V-T41 ROUND 6 DELTA FIX (reviewer):
    /// Shift-up runs in a `finally` — a boolean `false` from SendOneKeyEvent
    /// already let Shift-up run (no early return), but if SendOneKeyEvent
    /// itself THROWS between Shift-down and Shift-up, execution used to
    /// jump straight to the outer `catch` and skip Shift-up entirely,
    /// leaving Shift physically "held" for every keystroke sent afterward
    /// — the exact scenario rx-verify's own TypeKeystrokes guards against
    /// with a real try/finally.</summary>
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
            var label = $"SendChar '{ch}' vk=0x{vk:X2} scan=0x{scan:X2} shift={needsShift}";

            var shiftIsDown = false;
            var shiftDownOk = true;
            var charDownOk = false;
            var charUpOk = false;
            var shiftUpOk = true;
            try
            {
                if (needsShift)
                {
                    shiftDownOk = SendOneKeyEvent(VK_SHIFT, shiftScan, keyUp: false, log, $"{label} (Shift down)");
                    shiftIsDown = shiftDownOk;
                }

                charDownOk = SendOneKeyEvent(vk, scan, keyUp: false, log, $"{label} (down)");
                charUpOk = SendOneKeyEvent(vk, scan, keyUp: true, log, $"{label} (up)");
            }
            finally
            {
                if (shiftIsDown)
                {
                    shiftUpOk = SendOneKeyEvent(VK_SHIFT, shiftScan, keyUp: true, log, $"{label} (Shift up)");
                }
            }

            Thread.Sleep(NativeKeyboardTiming.KeystrokeCharDelay);

            return shiftDownOk && charDownOk && charUpOk && shiftUpOk;
        }
        catch (Exception ex)
        {
            log?.Invoke($"NativeKeyboard.SendChar '{ch}' -> threw {ex.GetType().Name}: {ex.Message}.");
            return false;
        }
    }

    /// <summary>Sends every character in `text` via SendChar, in order —
    /// SendChar's own trailing NativeKeyboardTiming.KeystrokeCharDelay
    /// sleep (V-T41 ROUND 6) naturally spaces every character this loop
    /// sends. Returns true only when every character was sent.</summary>
    public static bool SendText(string text, Action<string>? log = null)
    {
        var ok = true;
        foreach (var ch in text)
        {
            ok = SendChar(ch, log) && ok;
        }
        return ok;
    }

    /// <summary>Sends exactly one key-down or key-up event, applying
    /// KEYEVENTF_EXTENDEDKEY when NativeKeyEventFlags.IsExtendedKey(vk) —
    /// V-T41 ROUND 6 (reviewer blocking finding 2). Returns whether
    /// SendInput reported sending it.</summary>
    private static bool SendOneKeyEvent(ushort virtualKey, ushort scan, bool keyUp, Action<string>? log, string what)
    {
        var input = MakeKeyEvent(virtualKey, scan, keyUp);
        var events = new[] { input };
        var sent = SendInput(1, events, Marshal.SizeOf<NativeInput>());
        var ok = sent == 1;
        log?.Invoke($"NativeKeyboard.{what} -> SendInput returned {sent} (expected 1, ok={ok}).");
        return ok;
    }

    private static NativeInput MakeKeyEvent(ushort virtualKey, ushort scan, bool keyUp)
    {
        var flags = keyUp ? KEYEVENTF_KEYUP : 0u;
        if (NativeKeyEventFlags.IsExtendedKey(virtualKey))
        {
            flags |= NativeKeyEventFlags.KEYEVENTF_EXTENDEDKEY;
        }

        return new NativeInput
        {
            type = NativeInputType.Keyboard,
            u = new InputUnion
            {
                ki = new KEYBDINPUT
                {
                    wVk = virtualKey,
                    wScan = scan,
                    dwFlags = flags,
                    time = 0,
                    dwExtraInfo = 0,
                },
            },
        };
    }
}
