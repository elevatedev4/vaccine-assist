using System;
using System.IO;
using System.Text.Json;

namespace VaccineAssist.Desktop.Settings;

/// <summary>
/// Reads AutoLoginConfig as JSON from %LocalAppData%\VaccineAssist\autologin.json
/// — written by the repo root's bootstrap-fresh.ps1 one-liner, never by this
/// app itself. %LocalAppData% (non-roaming) is used rather than the
/// %AppData%\VaccineAssist\settings.json this app already writes to
/// (LocalSettingsService), so a plaintext shared-login password never rides
/// along in a roaming profile. Tolerant by design, matching
/// LocalSettingsService: a missing or corrupt file means "no auto-login
/// configured" rather than a startup crash.
/// </summary>
public sealed class AutoLoginConfigService : IAutoLoginConfigService
{
    private readonly string _filePath;

    public AutoLoginConfigService()
        : this(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "VaccineAssist",
            "autologin.json"))
    {
    }

    /// <summary>Injectable seam for unit tests — points at an arbitrary file
    /// path instead of the real %LocalAppData% location.</summary>
    public AutoLoginConfigService(string filePath)
    {
        _filePath = filePath;
    }

    public AutoLoginConfig? Load()
    {
        try
        {
            if (!File.Exists(_filePath))
            {
                return null;
            }

            var json = File.ReadAllText(_filePath);
            return JsonSerializer.Deserialize<AutoLoginConfig>(json);
        }
        catch
        {
            // Corrupt/unreadable file — no auto-login rather than a crash
            // at startup; the Login screen's manual form is always the
            // fallback (see LoginViewModel.TryAutoSignInAsync).
            return null;
        }
    }
}
