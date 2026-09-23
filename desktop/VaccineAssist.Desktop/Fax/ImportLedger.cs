using System.Text.Json;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// %AppData%\VaccineAssist\fax\imported.json — a flat JSON array of row
/// fingerprints (ImmunizationRecord.Fingerprint) ever imported, across
/// every run, forever. Deliberately never pruned: the whole point is
/// "never fax the same administration twice," so an old fingerprint must
/// stay recognized no matter how much later a report happens to repeat
/// it (e.g. a corrected re-export of an old date range).
/// </summary>
public sealed class ImportLedger : IImportLedger
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    private readonly string _filePath;

    public ImportLedger()
        : this(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "VaccineAssist", "fax", "imported.json"))
    {
    }

    /// <summary>Injectable seam for unit tests.</summary>
    public ImportLedger(string filePath)
    {
        _filePath = filePath;
    }

    public IReadOnlySet<string> LoadFingerprints()
    {
        try
        {
            if (!File.Exists(_filePath))
            {
                return new HashSet<string>();
            }

            var json = File.ReadAllText(_filePath);
            var list = JsonSerializer.Deserialize<List<string>>(json);
            return list is null ? new HashSet<string>() : new HashSet<string>(list, StringComparer.OrdinalIgnoreCase);
        }
        catch
        {
            // Missing/corrupt file -> empty set, same tolerant-by-design
            // posture as every other file-backed store in this app
            // (LocalSettingsService, SessionStore, PrescriberDirectory).
            // A corrupt ledger losing its history is a real risk (a
            // once-faxed administration could be re-sent) but a scheduled
            // daily run crashing outright over a bad file on disk is a
            // worse failure mode — AppFileLog + the run summary's
            // rejected-file list are where an operator would actually see
            // this, not a thrown exception nobody's watching for.
            return new HashSet<string>();
        }
    }

    public void AddFingerprints(IEnumerable<string> fingerprints)
    {
        var directory = Path.GetDirectoryName(_filePath);
        if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var existing = new HashSet<string>(LoadFingerprints(), StringComparer.OrdinalIgnoreCase);
        foreach (var fingerprint in fingerprints)
        {
            existing.Add(fingerprint);
        }

        var json = JsonSerializer.Serialize(existing.ToList(), JsonOptions);
        File.WriteAllText(_filePath, json);
    }
}
