using System.IO;
using System.Text.Json;

namespace VaccineAssist.Desktop.Fax;

/// <summary>One (AdministeredDate, VaccineName) pair from one sent run,
/// plus how many rows covered it — NEVER a patient identifier, not even
/// hashed (V-T65 R6, Will, verbatim, 2026-09-29: "We can't store patient
/// name ... store the administration dates, quantity on each date").</summary>
public sealed class FaxSentDateEntry
{
    /// <summary>yyyy-MM-dd.</summary>
    public string AdministeredDate { get; set; } = "";

    public string VaccineName { get; set; } = "";

    public int Count { get; set; }
}

/// <summary>One run's worth of FaxSentDateEntry — %AppData%\VaccineAssist\
/// fax\sent-files.json is a flat list of these, one per run that actually
/// sent something (see FaxRunOrchestrator).</summary>
public sealed class FaxSentRunEntry
{
    public DateTime RunAtUtc { get; set; }

    public List<FaxSentDateEntry> Entries { get; set; } = new();
}

public interface IFaxFileLedger
{
    List<FaxSentRunEntry> Load();

    /// <summary>Appends one run's (date, vaccine, count) entries — called
    /// ONLY for rows that were actually sent successfully this run (see
    /// FaxRunOrchestrator's own doc comment on what "successfully" means
    /// here). A no-op when <paramref name="entries"/> is empty — nothing
    /// to remember.</summary>
    void RecordRun(DateTime runAtUtc, IReadOnlyList<FaxSentDateEntry> entries);
}

/// <summary>
/// %AppData%\VaccineAssist\fax\sent-files.json — V-T65 R6 (Will, verbatim,
/// 2026-09-29): "How is the app determining what has already been sent?
/// We can't store patient name, and right now I tried to upload a report
/// with the same vaccines and patient name and different dates ... and it
/// skipped it and said it was already done ... we should just store the
/// administration dates, quantity on each date, and look for duplicates
/// that way, then show an alert."
///
/// Replaces the old shape (one entry per uploaded file: FileHash + FileName
/// + RecordedAtUtc + RowFingerprints — a whole-file SHA-256 refusal that
/// only ever matched a byte-for-byte-identical re-upload, and a
/// patient-derived RowFingerprints list Will doesn't want stored at all,
/// even hashed) with a flat list of RUNS, each holding only
/// (AdministeredDate, VaccineName, Count) — see FaxSentRunEntry/
/// FaxSentDateEntry. FaxFileHasher/the whole-file refusal path
/// (FaxRunOrchestrator.CheckAlreadyFullySent) are gone entirely; nothing
/// else in this app used the file hash, so there was nothing else to
/// preserve.
///
/// Same tolerant-by-design posture as FaxLedger/the old ImportLedger — a
/// missing/corrupt file loads as an empty list rather than throwing.
/// MIGRATION: a file still in the OLD shape (detected by the presence of
/// a "FileHash" property on its first element) is read as far as it can
/// be (RecordedAtUtc -> RunAtUtc; dates aren't recoverable from an old
/// row's SHA-256 fingerprint, so every migrated run's Entries list is
/// empty — it can never falsely match a new upload, but never crashes
/// over the old file either) and immediately rewritten in the new shape,
/// so this only happens once per install.
/// </summary>
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

    public List<FaxSentRunEntry> Load()
    {
        try
        {
            if (!File.Exists(_filePath))
            {
                return new List<FaxSentRunEntry>();
            }

            var json = File.ReadAllText(_filePath);
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array || doc.RootElement.GetArrayLength() == 0)
            {
                return new List<FaxSentRunEntry>();
            }

            var first = doc.RootElement[0];
            var isOldShape = first.TryGetProperty("FileHash", out _);
            if (!isOldShape)
            {
                return JsonSerializer.Deserialize<List<FaxSentRunEntry>>(json, JsonOptions) ?? new List<FaxSentRunEntry>();
            }

            return MigrateFromOldShape(json);
        }
        catch
        {
            // Missing/corrupt file -> empty list, same posture as every
            // other file-backed store in this app.
            return new List<FaxSentRunEntry>();
        }
    }

    public void RecordRun(DateTime runAtUtc, IReadOnlyList<FaxSentDateEntry> entries)
    {
        if (entries.Count == 0)
        {
            return;
        }

        var runs = Load();
        runs.Add(new FaxSentRunEntry { RunAtUtc = runAtUtc, Entries = entries.ToList() });
        Save(runs);
    }

    /// <summary>See class doc comment's MIGRATION paragraph. Rewrites the
    /// file in the new shape right away so this only runs once.</summary>
    private List<FaxSentRunEntry> MigrateFromOldShape(string json)
    {
        var oldEntries = JsonSerializer.Deserialize<List<LegacyFaxFileLedgerEntry>>(json, JsonOptions)
            ?? new List<LegacyFaxFileLedgerEntry>();

        var migrated = oldEntries
            .Select(e => new FaxSentRunEntry { RunAtUtc = e.RecordedAtUtc, Entries = new List<FaxSentDateEntry>() })
            .ToList();

        Save(migrated);
        return migrated;
    }

    private void Save(List<FaxSentRunEntry> runs)
    {
        var directory = Path.GetDirectoryName(_filePath);
        if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var json = JsonSerializer.Serialize(runs, JsonOptions);
        File.WriteAllText(_filePath, json);
    }

    /// <summary>The pre-R6 shape — kept ONLY so Load() can deserialize and
    /// migrate a file written before this change. Never written again.</summary>
    private sealed class LegacyFaxFileLedgerEntry
    {
        public string FileHash { get; set; } = "";
        public string FileName { get; set; } = "";
        public DateTime RecordedAtUtc { get; set; }
        public List<string> RowFingerprints { get; set; } = new();
    }
}
