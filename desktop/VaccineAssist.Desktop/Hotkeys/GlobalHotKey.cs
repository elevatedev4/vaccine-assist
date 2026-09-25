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
/// V-T3 (headline data-entry feature): registers Ctrl+NumPad7 against
/// MainWindow so a pharmacist can trigger vaccine data-entry mode from
/// inside PioneerRx itself, without alt-tabbing to this app first.
///
/// MSG893 hotfix (2026-09-07-ish, Will): moved off Ctrl+NumPad2 to
/// Ctrl+NumPad7 — NumPad2 collided with something else on the pharmacy's
/// workstations. Only the virtual-key constant changes here; everything
/// else about registration (MOD_CONTROL, the HwndSource hook, the
/// process-unique id) is unchanged.
///
/// 2026-09-13 (macro-codes popup, Ctrl+8): the virtual-key code used to be
/// hardcoded to VK_NUMPAD7 here. It's now a constructor parameter
/// (defaulting to VK_NUMPAD7, so MainWindow's existing data-entry hotkey
/// is unaffected) so a second, independent GlobalHotKey instance can
/// register Ctrl+8 for the macro-codes popup — same class, same
/// RegisterHotKey/UnregisterHotKey + HwndSource hook mechanism, same
/// per-instance registration/unregistration lifecycle, just a different
/// vk and a distinct id. See MainWindow's _macroCodesHotKey.
/// </summary>
public sealed class GlobalHotKey : IDisposable
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    /// <summary>MOD_CONTROL — see Win32 RegisterHotKey docs.</summary>
    public const uint MOD_CONTROL = 0x0002;

    /// <summary>VK_NUMPAD7 — see Win32 virtual-key codes.</summary>
    public const uint VK_NUMPAD7 = 0x67;

    /// <summary>VK '8' — the top-row number key (Win32 virtual-key codes
    /// for '0'-'9' are 0x30-0x39, matching ASCII). Used for Ctrl+8, the
    /// macro-codes popup hotkey (Will, 2026-09-13) — a different key than
    /// VK_NUMPAD7 so the two hotkeys never collide with each other.</summary>
    public const uint VK_8 = 0x38;

    /// <summary>VK_NUMPAD8 — see Win32 virtual-key codes. Replaces VK_8 as
    /// the macro-codes popup hotkey's virtual key (Will, 2026-09-13:
    /// "Make the activation key Ctrl+Keypad 8"), so the combination is
    /// Ctrl+NumPad8 instead of Ctrl+8. Distinct from VK_NUMPAD7 so the two
    /// hotkeys never collide with each other.</summary>
    public const uint VK_NUMPAD8 = 0x68;

    /// <summary>VK_NUMPAD4 — see Win32 virtual-key codes. 2026-09-25 (Will,
    /// verbatim): "Add new hotkey Ctrl+Keypad 4 that shows a screen to
    /// enter patient age..." — a third, independent GlobalHotKey instance
    /// registered the exact same way as the two above (see MainWindow's
    /// _ageMacroHotKey). Distinct from VK_NUMPAD7 and VK_NUMPAD8 so none of
    /// the three hotkeys ever collide with each other. Note this is a
    /// different key than VK_NUMPAD2 — the app deliberately does NOT
    /// register Ctrl+NumPad2 as a hotkey (see the MSG893 note above: that
    /// combination was moved to VK_NUMPAD7 because it collided with
    /// something else on the pharmacy's workstations), which is exactly
    /// why this feature can safely SEND a synthetic Ctrl+NumPad2 at the
    /// end of its flow (see MacroCodesWindow's sendCtrlNumPad2OnClose) —
    /// there's no RegisterHotKey claim on that combination in this process
    /// to swallow it.</summary>
    public const uint VK_NUMPAD4 = 0x64;

    private readonly Window _window;
    private readonly int _id;
    private readonly uint _vk;
    private HwndSource? _source;
    private bool _registered;

    /// <summary>Raised on the WPF dispatcher thread when the registered hotkey is pressed anywhere in the OS.</summary>
    public event EventHandler? Pressed;

    /// <param name="window">Must already have a native handle — call Register() after the window's SourceInitialized/Loaded event, not from its constructor.</param>
    /// <param name="id">A process-unique hotkey id (Win32 requires this per RegisterHotKey call).</param>
    /// <param name="vk">Virtual-key code to combine with MOD_CONTROL — defaults to VK_NUMPAD7 (the original V-T3 data-entry hotkey) so existing callers are unaffected. Pass VK_8 (or another VK_* constant) for a different Ctrl+&lt;key&gt; combination on its own instance.</param>
    public GlobalHotKey(Window window, int id, uint vk = VK_NUMPAD7)
    {
        _window = window;
        _id = id;
        _vk = vk;
    }

    /// <summary>Registers Ctrl+&lt;vk&gt;. Returns false (does not throw) if registration fails — e.g. another app already claimed that combination.</summary>
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

        _registered = RegisterHotKey(handle, _id, MOD_CONTROL, _vk);
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
