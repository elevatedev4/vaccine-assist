using System;
using System.IO;
using System.Text.Json;

namespace VaccineAssist.Desktop.Settings;

/// <summary>
/// Reads/writes AppSettings as JSON at
/// %AppData%\VaccineAssist\settings.json. Tolerant by design: a missing
/// or corrupt file returns fresh defaults rather than throwing, since
/// this file doesn't exist at all on a brand-new workstation checkout.
/// </summary>
public sealed class LocalSettingsService : ILocalSettingsService
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    private readonly string _settingsFilePath;

    public LocalSettingsService()
    {
        var appDataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "VaccineAssist");
        _settingsFilePath = Path.Combine(appDataDir, "settings.json");
    }

    public AppSettings Load()
    {
        try
        {
            if (!File.Exists(_settingsFilePath))
            {
                return new AppSettings();
            }

            var json = File.ReadAllText(_settingsFilePath);
            return JsonSerializer.Deserialize<AppSettings>(json) ?? new AppSettings();
        }
        catch
        {
            // Corrupt/unreadable settings file — fall back to defaults
            // rather than blocking the app from starting at all.
            return new AppSettings();
        }
    }

    public void Save(AppSettings settings)
    {
        var directory = Path.GetDirectoryName(_settingsFilePath);
        if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var json = JsonSerializer.Serialize(settings, JsonOptions);
        File.WriteAllText(_settingsFilePath, json);
    }
}
