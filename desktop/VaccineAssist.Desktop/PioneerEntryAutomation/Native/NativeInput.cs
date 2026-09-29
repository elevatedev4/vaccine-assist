using System.Runtime.InteropServices;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Native;

/// <summary>
/// V-T41 ROUND 5 (Will's 2026-09-29 follow-up on the still-not-saving
/// Priority dialog: "I have given you the exact keystrokes ... What the
/// fuck is wrong with you? Fix it."): the plain Win32 <c>INPUT</c> struct
/// family SendInput expects, laid out EXACTLY as user32.h defines it —
/// the standard SendInput P/Invoke shape (the same one InputSimulator and
/// every other native-keyboard-injection library uses), split into its
/// own file with NO DllImport/P/Invoke call of its own so it's directly
/// unit-testable on any OS via <c>Marshal.SizeOf</c> alone (struct layout
/// is CLR metadata, not a live Windows API call — see
/// NativeInputStructSizeTests.cs) — same "pure half in its own small
/// public type, no InternalsVisibleTo" split this codebase already uses
/// for PriorityInputGuard/PriorityWindowAnchorRule. NativeKeyboard.cs is
/// the impure half that actually calls SendInput with these.
/// </summary>
[StructLayout(LayoutKind.Sequential)]
public struct KEYBDINPUT
{
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public nint dwExtraInfo;
}

[StructLayout(LayoutKind.Sequential)]
public struct MOUSEINPUT
{
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public nint dwExtraInfo;
}

[StructLayout(LayoutKind.Sequential)]
public struct HARDWAREINPUT
{
    public uint uMsg;
    public ushort wParamL;
    public ushort wParamH;
}

/// <summary>The union member of INPUT — MOUSEINPUT is the largest member
/// (it, not KEYBDINPUT, is what forces the union — and therefore INPUT's
/// overall size — to 32/24 bytes on x64/x86; see NativeInputStructSizeTests).</summary>
[StructLayout(LayoutKind.Explicit)]
public struct InputUnion
{
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
}

/// <summary>The struct SendInput's <c>pInputs</c> array holds one of per
/// event. <c>Marshal.SizeOf&lt;NativeInput&gt;()</c> must equal Win32's
/// real <c>sizeof(INPUT)</c> — 40 bytes on x64, 28 on x86 (see
/// NativeInputStructSizeTests.InputStructSizeMatchesWin32Definition) — a
/// mismatch here means SendInput's <c>cbSize</c> argument is wrong, which
/// makes SendInput silently reject every call. This is the specific bug
/// class this whole round exists to rule out: FlaUI's own Keyboard.Type
/// gets this struct right but always leaves wScan at 0 (see
/// NativeKeyboard's own doc comment) — the shape is correct, only the
/// scan code was ever missing.</summary>
[StructLayout(LayoutKind.Sequential)]
public struct NativeInput
{
    public uint type;
    public InputUnion u;
}

/// <summary>INPUT.type values SendInput accepts — only Keyboard is used here.</summary>
public static class NativeInputType
{
    public const uint Keyboard = 1;
}
