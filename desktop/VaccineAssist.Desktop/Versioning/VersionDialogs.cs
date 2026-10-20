using System;
using System.Runtime.InteropServices;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Versioning;

/// <summary>
/// Message boxes for the version-switch path. A plain WPF MessageBox with no
/// owner can open BEHIND PioneerRx / the Topmost overlay (this app is often
/// tray-only and its overlay window never activates), which looks exactly
/// like "I clicked and nothing happened". These go straight to user32
/// MessageBoxW with MB_TOPMOST | MB_SETFOREGROUND so they always appear in
/// front of everything. Never throws.
/// </summary>
public static class VersionDialogs
{
    public const string Caption = "Vaccine Assist";
    public const string ConfirmCaption = "Switch version";

    private const uint MB_OK = 0x0000;
    private const uint MB_YESNO = 0x0004;
    private const uint MB_ICONWARNING = 0x0030;
    private const uint MB_ICONQUESTION = 0x0020;
    private const uint MB_DEFBUTTON2 = 0x0100;
    public const uint MB_SETFOREGROUND = 0x00010000;
    public const uint MB_TOPMOST = 0x00040000;
    private const int IDYES = 6;

    public const uint NoticeFlags = MB_OK | MB_ICONWARNING | MB_SETFOREGROUND | MB_TOPMOST;
    public const uint ConfirmFlags = MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2 | MB_SETFOREGROUND | MB_TOPMOST;

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

    /// <summary>Shows an OK box in front of every window and writes the message to the app log.</summary>
    public static void ShowNotice(string message)
    {
        AppFileLog.Log($"[Version] notice shown: {message.Replace('\n', ' ')}");
        try
        {
            MessageBoxW(IntPtr.Zero, message, Caption, NoticeFlags);
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("VersionDialogs.ShowNotice", ex);
        }
    }

    /// <summary>Yes/No box (default No) in front of every window. A failure to show it counts as "No" and is logged.</summary>
    public static bool Confirm(string message)
    {
        try
        {
            return MessageBoxW(IntPtr.Zero, message, ConfirmCaption, ConfirmFlags) == IDYES;
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("VersionDialogs.Confirm", ex);
            return false;
        }
    }
}
