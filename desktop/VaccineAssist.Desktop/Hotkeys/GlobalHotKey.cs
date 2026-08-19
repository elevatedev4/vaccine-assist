using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace VaccineAssist.Desktop.Hotkeys;

/// <summary>
/// App-wide (works even when the app isn't the foreground window) hotkey
/// registration via the standard Win32 RegisterHotKey/UnregisterHotKey +
/// WPF HwndSource interop pattern — no third-party library, matching this
/// app's dependency-light style (see App.xaml.cs's DI-light doc comment).
///
/// V-T3 (headline data-entry feature): registers Ctrl+NumPad2 against
/// MainWindow so a pharmacist can trigger vaccine data-entry mode from
/// inside PioneerRx itself, without alt-tabbing to this app first.
/// </summary>
public sealed class GlobalHotKey : IDisposable
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    /// <summary>MOD_CONTROL — see Win32 RegisterHotKey docs.</summary>
    public const uint MOD_CONTROL = 0x0002;

    /// <summary>VK_NUMPAD2 — see Win32 virtual-key codes.</summary>
    public const uint VK_NUMPAD2 = 0x62;

    private readonly Window _window;
    private readonly int _id;
    private HwndSource? _source;
    private bool _registered;

    /// <summary>Raised on the WPF dispatcher thread when the registered hotkey is pressed anywhere in the OS.</summary>
    public event EventHandler? Pressed;

    /// <param name="window">Must already have a native handle — call Register() after the window's SourceInitialized/Loaded event, not from its constructor.</param>
    /// <param name="id">A process-unique hotkey id (Win32 requires this per RegisterHotKey call).</param>
    public GlobalHotKey(Window window, int id)
    {
        _window = window;
        _id = id;
    }

    /// <summary>Registers Ctrl+NumPad2. Returns false (does not throw) if registration fails — e.g. another app already claimed that combination.</summary>
    public bool Register()
    {
        var handle = new WindowInteropHelper(_window).Handle;
        if (handle == IntPtr.Zero)
        {
            throw new InvalidOperationException(
                "GlobalHotKey.Register called before the window has a native handle — call after SourceInitialized.");
        }

        _source = HwndSource.FromHwnd(handle);
        _source?.AddHook(WndProc);

        _registered = RegisterHotKey(handle, _id, MOD_CONTROL, VK_NUMPAD2);
        return _registered;
    }

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (HotKeyMessage.TryParseHotKeyId(msg, wParam, out var hotKeyId) && hotKeyId == _id)
        {
            handled = true;
            Pressed?.Invoke(this, EventArgs.Empty);
        }
        return IntPtr.Zero;
    }

    public void Dispose()
    {
        if (_registered)
        {
            var handle = new WindowInteropHelper(_window).Handle;
            if (handle != IntPtr.Zero)
            {
                UnregisterHotKey(handle, _id);
            }
            _registered = false;
        }
        _source?.RemoveHook(WndProc);
        _source = null;
    }
}
