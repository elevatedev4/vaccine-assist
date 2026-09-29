using System.IO;
using System.Text.Json;

namespace VaccineAssist.Desktop.Fax;

/// <summary>One report file FaxRunOrchestrator has processed at least
/// once — V-T65 R5 ("make sure that things don't get re-sent if somebody
/// reuploads the same file"). Never a patient identifier on its own:
/// RowFingerprints are the same opaque SHA-256 hashes
/// ImmunizationRecord.Fingerprint/RowFingerprint already produce (no
/// patient name/DOB stored in the clear), and FileHash is a hash of the
/// report file's raw bytes, not its contents in readable form.</summary>
public sealed class FaxFileLedgerEntry
{
    public string FileHash { get; set; } = "";

    /// <summary>File NAME only (never a full path — a path can carry a
    /// Windows profile username, same reasoning as
    /// FaxSendViewModel.FileName).</summary>
    public string FileName { get; set; } = "";

    public DateTime RecordedAtUtc { get; set; }

    /// <summary>Every row fingerprint this file has contributed to the
    /// import ledger, across however many times it's been picked and sent
    /// — used to answer "has EVERY row in this file now been Sent?" by
    /// cross-referencing the live fax ledger (see
    /// FaxRunOrchestrator.CheckAlreadyFullySent), not a stale snapshot.</summary>
    public List<string> RowFingerprints { get; set; } = new();
}

public interface IFaxFileLedger
{
    List<FaxFileLedgerEntry> Load();

    /// <summary>Upserts the entry for <paramref name="fileHash"/> — creates
    /// it on first sight, otherwise merges in any new fingerprints (a file
    /// picked twice with some new rows added in between, say) and refreshes
    /// FileName/RecordedAtUtc.</summary>
    void Record(string fileHash, string fileName, IEnumerable<string> rowFingerprints);
}

/// <summary>%AppData%\VaccineAssist\fax\sent-files.json — same roaming
/// root, load/save-whole-file pattern, and tolerant-by-design posture as
/// FaxLedger/ImportLedger (a missing/corrupt file loads as an empty list
/// rather than throwing).</summary>
public sealed class FaxFileLedger : IFaxFileLedger
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    private readonly string _filePath;

    public FaxFileLedger()
        : this(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "VaccineAssist", "fax", "sent-files.json"))
    {
    }

    /// <summary>Injectable seam for unit tests.</summary>
    public FaxFileLedger(string filePath)
    {
        _filePath = filePath;
    }

    public List<FaxFileLedgerEntry> Load()
    {
        try
        {
            if (!File.Exists(_filePath))
            {
                return new List<FaxFileLedgerEntry>();
            }

            var json = File.ReadAllText(_filePath);
            return JsonSerializer.Deserialize<List<FaxFileLedgerEntry>>(json, JsonOptions) ?? new List<FaxFileLedgerEntry>();
        }
        catch
        {
            return new List<FaxFileLedgerEntry>();
        }
    }

    public void Record(string fileHash, string fileName, IEnumerable<string> rowFingerprints)
    {
        var entries = Load();
        var existing = entries.FirstOrDefault(e => string.Equals(e.FileHash, fileHash, StringComparison.OrdinalIgnoreCase));

        if (existing is null)
        {
            entries.Add(new FaxFileLedgerEntry
            {
                FileHash = fileHash,
                FileName = fileName,
                RecordedAtUtc = DateTime.UtcNow,
                RowFingerprints = rowFingerprints.Distinct(StringComparer.OrdinalIgnoreCase).ToList(),
            });
        }
        else
        {
            existing.FileName = fileName;
            existing.RecordedAtUtc = DateTime.UtcNow;
            var merged = new HashSet<string>(existing.RowFingerprints, StringComparer.OrdinalIgnoreCase);
            foreach (var fingerprint in rowFingerprints)
            {
                merged.Add(fingerprint);
            }
            existing.RowFingerprints = merged.ToList();
        }

        Save(entries);
    }

    private void Save(List<FaxFileLedgerEntry> entries)
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
