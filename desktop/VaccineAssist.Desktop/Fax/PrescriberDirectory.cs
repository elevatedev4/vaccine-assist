using System.Text.Json;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// %AppData%\VaccineAssist\fax\prescribers.json — Will's brief: "Rows with
/// no fax number are NOT sent; they appear in the summary as 'needs fax
/// number' with the prescriber name so Will can add it in the settings
/// window." Tolerant by design (missing/corrupt file = empty directory),
/// matching LocalSettingsService.
/// </summary>
public sealed class PrescriberDirectory : IPrescriberDirectory
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    private readonly string _filePath;

    public PrescriberDirectory()
        : this(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "VaccineAssist", "fax", "prescribers.json"))
    {
    }

    /// <summary>Injectable seam for unit tests.</summary>
    public PrescriberDirectory(string filePath)
    {
        _filePath = filePath;
    }

    public IReadOnlyList<PrescriberDirectoryEntry> Load()
    {
        try
        {
            if (!File.Exists(_filePath))
            {
                return Array.Empty<PrescriberDirectoryEntry>();
            }

            var json = File.ReadAllText(_filePath);
            return JsonSerializer.Deserialize<List<PrescriberDirectoryEntry>>(json)
                   ?? new List<PrescriberDirectoryEntry>();
        }
        catch
        {
            return Array.Empty<PrescriberDirectoryEntry>();
        }
    }

    public void Save(IReadOnlyList<PrescriberDirectoryEntry> entries)
    {
        var directory = Path.GetDirectoryName(_filePath);
        if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var json = JsonSerializer.Serialize(entries, JsonOptions);
        File.WriteAllText(_filePath, json);
    }

    public string? TryGetFaxNumber(string? prescriberName, string? prescriberNpi)
    {
        var entries = Load();

        if (!string.IsNullOrWhiteSpace(prescriberNpi))
        {
            var npiKey = "npi:" + FaxNumberNormalizer.StripToDigits(prescriberNpi);
            var byNpi = entries.FirstOrDefault(e => e.Key == npiKey);
            if (byNpi is not null && !string.IsNullOrWhiteSpace(byNpi.FaxNumber))
            {
                return byNpi.FaxNumber;
            }
        }

        if (!string.IsNullOrWhiteSpace(prescriberName))
        {
            var nameKey = "name:" + prescriberName.Trim().ToUpperInvariant();
            var byName = entries.FirstOrDefault(e => e.Key == nameKey);
            if (byName is not null && !string.IsNullOrWhiteSpace(byName.FaxNumber))
            {
                return byName.FaxNumber;
            }
        }

        return null;
    }
}
