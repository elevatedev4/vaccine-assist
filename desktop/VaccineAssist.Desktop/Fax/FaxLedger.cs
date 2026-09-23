using System.IO;
using System.Text.Json;

namespace VaccineAssist.Desktop.Fax;

/// <summary>%AppData%\VaccineAssist\fax\ledger.json — a flat JSON array
/// of FaxLedgerEntry, full-rewrite on every Save (same pattern as
/// LocalSettingsService/PrescriberDirectory — the ledger is small enough,
/// at ~3000 faxes/yr, that this is simpler and safer than incremental
/// updates). Tolerant by design: a missing/corrupt file loads as an empty
/// list rather than throwing.</summary>
public sealed class FaxLedger : IFaxLedger
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() },
    };

    private readonly string _filePath;

    public FaxLedger()
        : this(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "VaccineAssist", "fax", "ledger.json"))
    {
    }

    /// <summary>Injectable seam for unit tests.</summary>
    public FaxLedger(string filePath)
    {
        _filePath = filePath;
    }

    public List<FaxLedgerEntry> Load()
    {
        try
        {
            if (!File.Exists(_filePath))
            {
                return new List<FaxLedgerEntry>();
            }

            var json = File.ReadAllText(_filePath);
            return JsonSerializer.Deserialize<List<FaxLedgerEntry>>(json, JsonOptions) ?? new List<FaxLedgerEntry>();
        }
        catch
        {
            return new List<FaxLedgerEntry>();
        }
    }

    public void Save(List<FaxLedgerEntry> entries)
    {
        var directory = Path.GetDirectoryName(_filePath);
        if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var json = JsonSerializer.Serialize(entries, JsonOptions);
        File.WriteAllText(_filePath, json);
    }
}
