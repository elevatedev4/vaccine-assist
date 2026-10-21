using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// Single-attempt Win32 clipboard access for Unicode text. WPF's
/// Clipboard.SetText/GetText retry INSIDE the call (10 x 100 ms per OLE
/// step, about 1-2 s each) and cannot be shortened, so stacking our own retry
/// on top froze the UI for many seconds when another program held the
/// clipboard. OpenClipboard returns immediately when the clipboard is busy,
/// so each call here is effectively instant and throws on failure; the
/// retry/time budget lives in ClipboardRetry (one mechanism, about 1 s total).
/// </summary>
internal static class NativeClipboard
{
    private const uint CfUnicodeText = 13;
    private const uint GmemMoveable = 0x0002;
    private static readonly IntPtr HwndMessage = new(-3);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool OpenClipboard(IntPtr hWndNewOwner);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EmptyClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetClipboardData(uint format, IntPtr memory);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetClipboardData(uint format);

    [DllImport("user32.dll")]
    private static extern bool IsClipboardFormatAvailable(uint format);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowExW(
        uint exStyle, string className, string? windowName, uint style,
        int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyWindow(IntPtr hwnd);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalLock(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalUnlock(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalFree(IntPtr memory);

    /// <summary>One attempt to put <paramref name="text"/> on the clipboard. Throws (Win32Exception) when the clipboard is busy or the call fails.</summary>
    public static void SetText(string text)
    {
        // Emptying the clipboard needs a real owner window (a NULL owner makes
        // SetClipboardData fail afterwards): a short-lived message-only window.
        var owner = CreateWindowExW(0, "STATIC", null, 0, 0, 0, 0, 0, HwndMessage, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (owner == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        try
        {
            if (!OpenClipboard(owner))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            try
            {
                if (!EmptyClipboard())
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }

                var characters = text.ToCharArray();
                var memory = GlobalAlloc(GmemMoveable, (UIntPtr)((characters.Length + 1) * 2));
                if (memory == IntPtr.Zero)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }

                var handedToSystem = false;
                try
                {
                    var target = GlobalLock(memory);
                    if (target == IntPtr.Zero)
                    {
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    }

                    try
                    {
                        Marshal.Copy(characters, 0, target, characters.Length);
                        Marshal.WriteInt16(target, characters.Length * 2, 0);
                    }
                    finally
                    {
                        GlobalUnlock(memory);
                    }

                    if (SetClipboardData(CfUnicodeText, memory) == IntPtr.Zero)
                    {
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    }

                    handedToSystem = true; // the system owns the memory now
                }
                finally
                {
                    if (!handedToSystem)
                    {
                        GlobalFree(memory);
                    }
                }
            }
            finally
            {
                CloseClipboard();
            }
        }
        finally
        {
            DestroyWindow(owner);
        }
    }

    /// <summary>One attempt to read the clipboard's text. Null when it holds no text; throws when the clipboard is busy.</summary>
    public static string? GetText()
    {
        if (!OpenClipboard(IntPtr.Zero))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        try
        {
            if (!IsClipboardFormatAvailable(CfUnicodeText))
            {
                return null;
            }

            var handle = GetClipboardData(CfUnicodeText);
            if (handle == IntPtr.Zero)
            {
                return null;
            }

            var source = GlobalLock(handle);
            if (source == IntPtr.Zero)
            {
                return null;
            }

            try
            {
                return Marshal.PtrToStringUni(source);
            }
            finally
            {
                GlobalUnlock(handle);
            }
        }
        finally
        {
            CloseClipboard();
        }
    }

    /// <summary>One attempt to empty the clipboard. Throws when it is busy.</summary>
    public static void Clear()
    {
        if (!OpenClipboard(IntPtr.Zero))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        try
        {
            if (!EmptyClipboard())
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        finally
        {
            CloseClipboard();
        }
    }
}
