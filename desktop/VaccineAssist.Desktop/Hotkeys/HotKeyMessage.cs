using System;

namespace VaccineAssist.Desktop.Hotkeys;

/// <summary>
/// Pure parsing of the Win32 WM_HOTKEY window message — no HwndSource/
/// Win32 dependency itself, so it's covered by fast xUnit tests instead
/// of only a manual trace. GlobalHotKey (the actual HwndSourceHook) is
/// the only production caller.
/// </summary>
public static class HotKeyMessage
{
    /// <summary>Win32 WM_HOTKEY constant.</summary>
    public const int WM_HOTKEY = 0x0312;

    /// <summary>
    /// True + the registered hotkey's id (the low word of wParam, per the
    /// WM_HOTKEY contract) when <paramref name="msg"/> is WM_HOTKEY;
    /// false (id = 0) for any other message — callers should leave those
    /// unhandled and let the window proc continue normally.
    /// </summary>
    public static bool TryParseHotKeyId(int msg, IntPtr wParam, out int hotKeyId)
    {
        if (msg != WM_HOTKEY)
        {
            hotKeyId = 0;
            return false;
        }

        // WM_HOTKEY's hotkey id is the low-order word of wParam.
        hotKeyId = unchecked((int)((long)wParam & 0xFFFF));
        return true;
    }
}
