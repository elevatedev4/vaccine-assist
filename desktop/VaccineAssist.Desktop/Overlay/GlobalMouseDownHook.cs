using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace VaccineAssist.Desktop.Overlay;

/// <summary>
/// V-T42 (Will, verbatim): "when I click on the vaccine icon on pioneer and
/// then click away from it, the menu should close but doesn't." A plain
/// WPF ContextMenu's own "close on outside click" handling is only
/// reliable for a click that lands inside THIS app's own windows — a click
/// on Pioneer (a separate process' window) needs a systemwide notification,
/// which is exactly what a WH_MOUSE_LL low-level hook provides: Windows
/// calls it for every left/right mouse-down anywhere on the desktop, on
/// the SAME thread that installed it (this app's UI thread), so it's safe
/// to touch WPF objects directly from <see cref="MouseDown"/> — no cross-
/// thread marshaling needed (PioneerOverlayWindow still posts back through
/// its Dispatcher regardless, as cheap insurance against the hook firing
/// during an unusual reentrant callback).
///
/// Thin Win32 wrapper only — PioneerOverlayWindow owns install/uninstall
/// timing (only while its menu is open) and all geometry decisions (see
/// OverlayMenuGeometry, the pure/testable half of this fix). Never throws:
/// a failed SetWindowsHookEx just means the global fallback silently
/// doesn't fire, same "best-effort" posture as every other Win32 wrapper
/// in this codebase (see NativeOverlayPositioning).
/// </summary>
internal sealed class GlobalMouseDownHook : IDisposable
{
    private const int WH_MOUSE_LL = 14;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_RBUTTONDOWN = 0x0204;

    private delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);

    // Kept as a field (not a local/lambda) so the delegate is never
    // garbage-collected while the native hook holds a pointer to it.
    private readonly LowLevelMouseProc _proc;
    private IntPtr _hookHandle = IntPtr.Zero;

    /// <summary>Screen-coordinate (x, y) of a global left/right mouse-down — the same coordinate space MSLLHOOKSTRUCT.pt reports.</summary>
    public event Action<int, int>? MouseDown;

    public GlobalMouseDownHook()
    {
        _proc = HookCallback;
    }

    /// <summary>No-op if already installed. Best-effort — never throws.</summary>
    public void Install()
    {
        if (_hookHandle != IntPtr.Zero) return;
        try
        {
            using var curProcess = Process.GetCurrentProcess();
            using var curModule = curProcess.MainModule;
            var moduleHandle = curModule is not null ? GetModuleHandle(curModule.ModuleName) : IntPtr.Zero;
            _hookHandle = SetWindowsHookEx(WH_MOUSE_LL, _proc, moduleHandle, 0);
        }
        catch
        {
            _hookHandle = IntPtr.Zero;
        }
    }

    /// <summary>No-op if not installed. Best-effort — never throws.</summary>
    public void Uninstall()
    {
        if (_hookHandle == IntPtr.Zero) return;
        try
        {
            UnhookWindowsHookEx(_hookHandle);
        }
        catch
        {
            // Best-effort — see class doc comment.
        }
        finally
        {
            _hookHandle = IntPtr.Zero;
        }
    }

    public void Dispose() => Uninstall();

    private IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            if (nCode >= 0 && (wParam == (IntPtr)WM_LBUTTONDOWN || wParam == (IntPtr)WM_RBUTTONDOWN))
            {
                var hookStruct = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
                MouseDown?.Invoke(hookStruct.pt.X, hookStruct.pt.Y);
            }
        }
        catch
        {
            // Never let a subscriber's exception break the systemwide hook chain.
        }
        return CallNextHookEx(_hookHandle, nCode, wParam, lParam);
    }
}
