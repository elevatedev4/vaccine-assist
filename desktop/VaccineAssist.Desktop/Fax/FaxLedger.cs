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

    /// <summary>V-T65 R7 review follow-up (non-blocking note from R5:
    /// "non-atomic JSON writes in the Fax ledgers"): writes to a temp file
    /// next to the real one, then File.Move(overwrite:true) — a single
    /// filesystem rename, so a crash/power-loss/AV-scan mid-write can
    /// never leave ledger.json half-written (the old plain
    /// File.WriteAllText could, and the receipt poller's own tick — 15s
    /// while a fax is under 5 min old — makes that window come up
    /// often).</summary>
    public void Save(List<FaxLedgerEntry> entries)
    {
        var directory = Path.GetDirectoryName(_filePath);
        if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var json = JsonSerializer.Serialize(entries, JsonOptions);
        var tempPath = _filePath + ".tmp-" + Guid.NewGuid().ToString("n");
        File.WriteAllText(tempPath, json);
        File.Move(tempPath, _filePath, overwrite: true);
    }
}
